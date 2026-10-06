import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class {}, routeAgentRequest: vi.fn() }));

import { TraderAgent } from "../src/agent/agent.js";
import {
  executeMeasuredSql,
  ensureStorage,
  type SqlExecutor,
} from "../src/storage/schema.js";
import {
  loadAllAutonomousJournals,
  loadAllEvents,
  loadAllExperiences,
  loadAllStoredCycles,
  loadJournalBackfillPage,
  loadLatestCompletedCyclePlanFromHistory,
  loadOpenExperiences,
  loadRecentJournals,
  recordIdempotency,
  recordProviderOrderReference,
} from "../src/storage/store.js";
import { resolveProviderOrigin } from "../src/storage/provider-ledger.js";

type SqlValue = string | number | boolean | null;

function makeExecutor(db: DatabaseSync, measured = false): SqlExecutor {
  const run = <T>(query: string, values: SqlValue[]): T[] => {
    const normalized = query.trimStart().toUpperCase();
    const sqliteValues = values.map((value) => typeof value === "boolean" ? Number(value) : value) as (string | number | null)[];
    if (normalized.startsWith("SELECT") || normalized.startsWith("WITH")) {
      return db.prepare(query).all(...sqliteValues) as T[];
    }
    db.prepare(query).run(...sqliteValues);
    return [];
  };
  const executor = {
    sql<T>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] {
      return run<T>(strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), ""), values);
    },
  } as SqlExecutor;

  if (!measured) return executor;

  const ctx = {
    storage: {
      sql: {
        exec(query: string, ...values: SqlValue[]) {
          const rows = run<Record<string, unknown>>(query, values);
          return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
        },
      },
    },
  };
  const agent = { ctx };
  return Object.assign(executor, {
    ctx,
    measuredSql: TraderAgent.prototype.measuredSql.bind(agent as never),
  }) as SqlExecutor;
}

function telemetry(logSpy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return logSpy.mock.calls.flatMap((call) => {
    const value = call[0];
    if (typeof value !== "string") return [];
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null ? [parsed as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

describe("existing Durable Object SQL read telemetry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the same rows through measured and raw executor paths", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE telemetry_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO telemetry_fixture (id, value) VALUES (?, ?)").run(1, "same-row");
    const raw = makeExecutor(db);
    const measured = makeExecutor(db, true);

    const expected = raw.sql<{ id: number; value: string }>`SELECT id, value FROM telemetry_fixture WHERE id = ${1}`;
    const actual = executeMeasuredSql<{ id: number; value: string }>(measured, "test", "fixture_lookup")`SELECT id, value FROM telemetry_fixture WHERE id = ${1}`;

    expect(actual).toEqual(expected);
    db.close();
  });

  it("keeps scheduled-cycle and paper-log caller labels distinct and labels startup reads", () => {
    const db = new DatabaseSync(":memory:");
    const raw = makeExecutor(db);
    ensureStorage(raw);
    db.prepare("INSERT INTO journals (cycle_id, payload, created_at) VALUES (?, ?, ?)")
      .run("cycle-1", JSON.stringify({ cycleId: "cycle-1", mode: "AUTONOMOUS" }), "2026-10-06T00:00:00.000Z");
    const executor = makeExecutor(db, true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const scheduledRows = loadAllAutonomousJournals(executor, undefined, undefined, "scheduled_cycle", "position_management_full_journal_history");
    const exportRows = loadAllAutonomousJournals(executor, undefined, undefined, "/api/export/paper-log", "paper_log_all_journals");
    expect(scheduledRows).toEqual(exportRows);

    loadAllStoredCycles(executor, undefined, undefined, "/api/export/paper-log", "paper_log_all_cycles");
    loadAllExperiences(executor, "/api/export/paper-log", "paper_log_all_experiences");
    loadAllEvents(executor, "/api/export/paper-log", "paper_log_all_events");
    loadAllExperiences(executor, "late_reconciliation", "late_reconciliation_all_experiences");
    loadAllEvents(executor, "late_reconciliation", "late_reconciliation_all_events");
    loadRecentJournals(executor, 50, "on_start", "on_start_quarantine_recent_journals");
    loadOpenExperiences(executor, 100, "on_start", "on_start_bootstrap_open_experiences");
    loadLatestCompletedCyclePlanFromHistory(executor, "on_start", "on_start_latest_completed_cycle_plan");
    loadJournalBackfillPage(executor, null, 50, "on_start", "on_start_execution_quarantine_journal_page");

    const records = telemetry(logSpy);
    expect(records.map(({ path, queryName }) => ({ path, queryName }))).toEqual([
      { path: "scheduled_cycle", queryName: "position_management_full_journal_history" },
      { path: "/api/export/paper-log", queryName: "paper_log_all_journals" },
      { path: "/api/export/paper-log", queryName: "paper_log_all_cycles" },
      { path: "/api/export/paper-log", queryName: "paper_log_all_experiences" },
      { path: "/api/export/paper-log", queryName: "paper_log_all_events" },
      { path: "late_reconciliation", queryName: "late_reconciliation_all_experiences" },
      { path: "late_reconciliation", queryName: "late_reconciliation_all_events" },
      { path: "on_start", queryName: "on_start_quarantine_recent_journals" },
      { path: "on_start", queryName: "on_start_bootstrap_open_experiences" },
      { path: "on_start", queryName: "on_start_latest_completed_cycle_plan" },
      { path: "on_start", queryName: "on_start_execution_quarantine_journal_page" },
    ]);
    db.close();
  });

  it("preserves provider-origin decisions while measuring each lookup", () => {
    const db = new DatabaseSync(":memory:");
    const raw = makeExecutor(db);
    ensureStorage(raw);
    recordIdempotency(raw, "client-1", "cycle-1", "decision-1", "2026-10-06T00:00:00.000Z");
    recordProviderOrderReference(raw, "client-1", "order-1");
    const measured = makeExecutor(db, true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(resolveProviderOrigin(measured, "order-1", "client-1")).toBe(resolveProviderOrigin(raw, "order-1", "client-1"));
    expect(resolveProviderOrigin(measured, "external-order", "external-client", "PROVIDER_EXTERNAL"))
      .toBe(resolveProviderOrigin(raw, "external-order", "external-client", "PROVIDER_EXTERNAL"));
    expect(telemetry(logSpy).map(({ path, queryName }) => ({ path, queryName }))).toEqual([
      { path: "scheduled_provider_sync", queryName: "provider_sync_origin_client_oid_lookup" },
      { path: "scheduled_provider_sync", queryName: "provider_sync_origin_client_oid_lookup" },
      { path: "scheduled_provider_sync", queryName: "provider_sync_origin_provider_order_lookup" },
      { path: "scheduled_provider_sync", queryName: "provider_sync_origin_fallback_lookup" },
    ]);
    db.close();
  });

  it("logs only safe telemetry fields, never SQL bindings or financial payloads", () => {
    const db = new DatabaseSync(":memory:");
    const executor = makeExecutor(db, true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const privateClientOid = "private-client-oid-value";
    const financialPayload = JSON.stringify({ symbol: "PRIVATEUSDT", quantity: "9876.543", realizedPnl: "42.50" });

    const rows = executeMeasuredSql<{ client_oid: string; payload: string }>(executor, "scheduled_provider_sync", "provider_sync_origin_client_oid_lookup")`
      SELECT ${privateClientOid} AS client_oid, ${financialPayload} AS payload
    `;

    expect(rows[0]).toEqual({ client_oid: privateClientOid, payload: financialPayload });
    const emitted = telemetry(logSpy);
    expect(emitted).toEqual([{
      event: "DO_SQL_READ",
      path: "scheduled_provider_sync",
      queryName: "provider_sync_origin_client_oid_lookup",
      rowsRead: 1,
    }]);
    const encoded = JSON.stringify(emitted);
    expect(encoded).not.toContain(privateClientOid);
    expect(encoded).not.toContain(financialPayload);
    expect(encoded).not.toContain("PRIVATEUSDT");
    db.close();
  });
});
