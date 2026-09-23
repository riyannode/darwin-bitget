import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { PROVIDER_FINANCIAL_CATEGORIES } from "../src/bitget/provider-sync.js";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { resolveExternalFlowReadModel, type FinancialFlowCategoryState } from "../src/trading/external-flow-read-model.js";

type SqlValue = string | number | boolean | null;

function memoryExecutor(): { db: DatabaseSync; executor: SqlExecutor } {
  const db = new DatabaseSync(":memory:");
  const executor: SqlExecutor = {
    sql<T>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] {
      const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
      const params = values.map((value) => typeof value === "boolean" ? Number(value) : value) as (string | number | null)[];
      const normalized = query.trimStart().toUpperCase();
      if (normalized.startsWith("SELECT") || normalized.startsWith("WITH")) return db.prepare(query).all(...params) as T[];
      db.prepare(query).run(...params);
      return [];
    },
  };
  ensureStorage(executor);
  return { db, executor };
}

function categoryStates(revision = 1): FinancialFlowCategoryState[] {
  return PROVIDER_FINANCIAL_CATEGORIES.map((category) => ({
    category,
    complete: true,
    lastError: null,
    revision: category === "USDT-FUTURES" ? revision : 1,
    updatedAt: `2026-09-23T00:00:${String(category === "USDT-FUTURES" ? revision : 1).padStart(2, "0")}.000Z`,
    lastSuccessfulSyncAt: "2026-09-23T00:00:00.000Z",
    coveredFrom: "2026-09-01T00:00:00.000Z",
    coveredThrough: "2026-09-23T00:00:00.000Z",
    financialRecordCount: category === "USDT-FUTURES" ? revision : 0,
  }));
}

function insertFinancialRecord(executor: SqlExecutor, key: string, type: string, amount: string, timestamp: string): void {
  executor.sql`INSERT INTO provider_financial_records (
    provider_record_key, provider_record_id, category, symbol, type, position_type, coin, amount, fee,
    position_amount, position_balance, balance, provider_timestamp, origin, raw_provider_json, first_seen_at, last_seen_at
  ) VALUES (
    ${key}, ${key}, 'USDT-FUTURES', 'BTCUSDT', ${type}, null, 'USDT', ${amount}, '0',
    null, null, null, ${timestamp}, 'UNATTRIBUTED', '{}', ${timestamp}, ${timestamp}
  )`;
}

describe("durable external-flow read model", () => {
  it("reuses the cached result until a provider-sync revision or baseline changes", () => {
    const { db, executor } = memoryExecutor();
    insertFinancialRecord(executor, "flow-in-1", "TRANSFER_IN", "10", "2026-09-02T00:00:00.000Z");
    const first = resolveExternalFlowReadModel(executor, "2026-09-01T00:00:00.000Z", "1000", categoryStates(1), PROVIDER_FINANCIAL_CATEGORIES, "2026-09-23T00:01:00.000Z");
    expect(first).toMatchObject({ cacheHit: false, recordsRead: 1, truncated: false, flows: { status: "VERIFIED", netExternalInflows: "10" } });

    const repeated = resolveExternalFlowReadModel(executor, "2026-09-01T00:00:00.000Z", "1000", categoryStates(1), PROVIDER_FINANCIAL_CATEGORIES, "2026-09-23T00:02:00.000Z");
    expect(repeated).toMatchObject({ cacheHit: true, recordsRead: 0, flows: { status: "VERIFIED", netExternalInflows: "10" } });

    insertFinancialRecord(executor, "flow-out-1", "TRANSFER_OUT", "-4", "2026-09-06T00:00:00.000Z");
    const afterSync = resolveExternalFlowReadModel(executor, "2026-09-01T00:00:00.000Z", "1000", categoryStates(2), PROVIDER_FINANCIAL_CATEGORIES, "2026-09-23T00:03:00.000Z");
    expect(afterSync).toMatchObject({ cacheHit: false, recordsRead: 2, flows: { status: "VERIFIED", netExternalInflows: "6" } });

    const afterBaselineEquityChange = resolveExternalFlowReadModel(executor, "2026-09-01T00:00:00.000Z", "1010", categoryStates(2), PROVIDER_FINANCIAL_CATEGORIES, "2026-09-23T00:03:30.000Z");
    expect(afterBaselineEquityChange).toMatchObject({ cacheHit: false, recordsRead: 2, flows: { status: "VERIFIED", netExternalInflows: "6" } });

    const afterBaselineReset = resolveExternalFlowReadModel(executor, "2026-09-05T00:00:00.000Z", "1010", categoryStates(2), PROVIDER_FINANCIAL_CATEGORIES, "2026-09-23T00:04:00.000Z");
    expect(afterBaselineReset).toMatchObject({ cacheHit: false, recordsRead: 1, flows: { status: "VERIFIED", netExternalInflows: "-4" } });
    db.close();
  });

  it("does not read financial records until all six category windows are complete", () => {
    const { db, executor } = memoryExecutor();
    insertFinancialRecord(executor, "flow-in-1", "TRANSFER_IN", "10", "2026-09-02T00:00:00.000Z");
    const incomplete = categoryStates().map((category) => category.category === "SPOT" ? { ...category, complete: false } : category);
    const first = resolveExternalFlowReadModel(executor, "2026-09-01T00:00:00.000Z", "1000", incomplete, PROVIDER_FINANCIAL_CATEGORIES, "2026-09-23T00:01:00.000Z");
    expect(first).toMatchObject({ cacheHit: false, recordsRead: 0, flows: { status: "UNVERIFIED", netExternalInflows: "UNAVAILABLE" } });
    const complete = resolveExternalFlowReadModel(executor, "2026-09-01T00:00:00.000Z", "1000", categoryStates(), PROVIDER_FINANCIAL_CATEGORIES, "2026-09-23T00:02:00.000Z");
    expect(complete).toMatchObject({ cacheHit: false, recordsRead: 1, flows: { status: "VERIFIED", netExternalInflows: "10" } });
    db.close();
  });
});
