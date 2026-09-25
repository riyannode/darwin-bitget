import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  normalizeProviderFill,
  normalizeProviderFinancialRecord,
  normalizeProviderOrder,
  normalizeProviderPositionHistory,
  providerPage,
  providerTimestampIso,
  stableProviderFingerprint,
} from "../src/bitget/provider-ledger.js";
import { PROVIDER_FINANCIAL_CATEGORIES, syncProviderLedger, type ProviderLedgerReadClient } from "../src/bitget/provider-sync.js";
import {
  loadProviderFinancialRecordsSinceCategories,
  loadProviderLifecycleEvidenceBatch,
  loadProviderPositionHistoriesPage,
  loadRecentProviderPositionHistories,
  loadProviderSyncState,
  saveProviderSyncState,
  providerLedgerDiagnostics,
  resolveProviderOrigin,
  upsertProviderFill,
  upsertProviderFinancialRecord,
  upsertProviderOrder,
  upsertProviderPositionHistory,
} from "../src/storage/provider-ledger.js";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { recordIdempotency, recordProviderOrderReference } from "../src/storage/store.js";

type SqlValue = string | number | boolean | null;

function memoryExecutor(db = new DatabaseSync(":memory:")): { db: DatabaseSync; executor: SqlExecutor; queries: string[]; queryParams: SqlValue[][] } {
  const queries: string[] = [];
  const queryParams: SqlValue[][] = [];
  const executor: SqlExecutor = {
    sql<T>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] {
      const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
      queries.push(query);
      queryParams.push([...values]);
      const sqliteValues = values.map((value) => typeof value === "boolean" ? (value ? 1 : 0) : value) as (string | number | null)[];
      const normalizedQuery = query.trimStart().toUpperCase();
      if (normalizedQuery.startsWith("SELECT") || normalizedQuery.startsWith("WITH")) return db.prepare(query).all(...sqliteValues) as T[];
      db.prepare(query).run(...sqliteValues);
      return [];
    },
  };
  ensureStorage(executor);
  return { db, executor, queries, queryParams };
}

const observedAt = "2026-09-22T00:00:00.000Z";
const category = "USDT-FUTURES";

function orderFixture(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "order-1",
    clientOid: "paper-cycle-1",
    category,
    symbol: "CRCLUSDT",
    side: "buy",
    posSide: "long",
    tradeSide: "open",
    reduceOnly: "NO",
    orderType: "market",
    qty: "3.25",
    cumExecQty: "3.25",
    cumExecValue: "312.5",
    avgPrice: "96.15384615",
    orderStatus: "filled",
    feeDetail: [{ feeCoin: "USDT", fee: "0.125" }],
    createdTime: "1730181468493",
    updatedTime: "1730181468593",
    ...overrides,
  };
}

function fillFixture(overrides: Record<string, unknown> = {}) {
  return {
    execId: "fill-1",
    orderId: "order-1",
    clientOid: "paper-cycle-1",
    category,
    symbol: "CRCLUSDT",
    side: "buy",
    posSide: "long",
    tradeSide: "open",
    execQty: "3.25",
    execPrice: "96.15384615",
    execValue: "312.5",
    execPnl: "0",
    feeDetail: [{ feeCoin: "USDT", fee: "0.125" }],
    createdTime: "1730181468493",
    updatedTime: "1730181468593",
    ...overrides,
  };
}

function positionHistoryFixture(overrides: Record<string, unknown> = {}) {
  return {
    positionId: "position-1",
    category,
    symbol: "CRCLUSDT",
    posSide: "long",
    openPriceAvg: "96.15",
    closePriceAvg: "101.25",
    openTotalPos: "3.25",
    closeTotalPos: "3.25",
    cumRealisedPnl: "16.706",
    netProfit: "16.575",
    totalFunding: "-0.01",
    openFeeTotal: "0.125",
    closeFeeTotal: "0.131",
    cashDividend: "0",
    createdTime: "1730181468493",
    updatedTime: "1730182468493",
    ...overrides,
  };
}

function financialFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "financial-1",
    category,
    symbol: "CRCLUSDT",
    type: "ORDER_DEALT_IN",
    positionType: "crossed",
    coin: "USDT",
    amount: "312.5",
    fee: "-0.125",
    positionAmount: "3.25",
    positionBalance: "3.25",
    balance: "50000.125",
    ts: "1730181468493",
    ...overrides,
  };
}

describe("provider ledger normalization", () => {
  it("normalizes provider timestamps without floating point conversion", () => {
    expect(providerTimestampIso("1730181468493")).toBe("2024-10-29T05:57:48.493Z");
    expect(providerTimestampIso("2026-09-22T00:00:00.000Z")).toBe("2026-09-22T00:00:00.000Z");
    expect(providerTimestampIso("not-a-timestamp")).toBeNull();
  });

  it("normalizes orders, fills, position history, and financial records", () => {
    const order = normalizeProviderOrder(orderFixture(), "DARWIN", observedAt);
    const fill = normalizeProviderFill(fillFixture(), "DARWIN", observedAt);
    const history = normalizeProviderPositionHistory(positionHistoryFixture(), observedAt);
    const financial = normalizeProviderFinancialRecord(financialFixture(), observedAt);

    expect(order).toMatchObject({ providerOrderId: "order-1", qty: "3.25", avgPrice: "96.15384615", feeTotal: "0.125", origin: "DARWIN" });
    expect(fill).toMatchObject({ execId: "fill-1", execQty: "3.25", execPrice: "96.15384615", feeTotal: "0.125", origin: "DARWIN" });
    expect(history).toMatchObject({ providerPositionHistoryKey: "position-1", positionSide: "LONG", closingQuantity: "3.25", positionPnl: "16.575", origin: "UNATTRIBUTED" });
    expect(financial).toMatchObject({ providerRecordKey: "USDT-FUTURES:financial-1", providerRecordId: "financial-1", positionType: "crossed", amount: "312.5", origin: "UNATTRIBUTED" });
    expect(order?.rawProviderJson).toContain("order-1");
    expect(fill?.rawProviderJson).toContain("fill-1");
    expect(history?.rawProviderJson).toContain("position-1");
    expect(financial?.rawProviderJson).toContain("financial-1");

    const actualFieldNames = normalizeProviderPositionHistory({
      category,
      symbol: "CRCLUSDT",
      posSide: "long",
      positionId: "actual-1",
      createdTime: "1730181468493",
      updatedTime: "1730182468493",
      openTotalPos: "8.5",
      closeTotalPos: "8.5",
      openPriceAvg: "96.15",
      closePriceAvg: "101.25",
      cumRealisedPnl: "16.575",
      netProfit: "16.575",
    }, observedAt);
    expect(actualFieldNames).toMatchObject({ openingTime: "2024-10-29T05:57:48.493Z", closingQuantity: "8.5", openTotalPos: "8.5", closeTotalPos: "8.5", cumRealisedPnl: "16.575", netProfit: "16.575", maxPositionSize: "8.5" });
  });

  it("treats a provider null list as an empty page", () => {
    expect(providerPage({ data: { list: null, cursor: null } })).toEqual({ rows: [], cursor: null });
  });

  it("rejects malformed provider rows and fingerprints rows without provider IDs", () => {
    expect(normalizeProviderOrder({ orderId: "", createdTime: "bad" }, "PROVIDER_EXTERNAL", observedAt)).toBeNull();
    expect(normalizeProviderFill({ execId: "", createdTime: "bad" }, "PROVIDER_EXTERNAL", observedAt)).toBeNull();
    expect(normalizeProviderFinancialRecord({ category, type: "TRANSFER_IN", ts: "bad" }, observedAt)).toBeNull();
    const first = normalizeProviderPositionHistory(positionHistoryFixture({ positionId: undefined }), observedAt);
    const second = normalizeProviderPositionHistory({ ...positionHistoryFixture({ positionId: undefined }), symbol: "CRCLUSDT" }, observedAt);
    expect(first?.providerPositionHistoryKey).toMatch(/^fingerprint:/);
    expect(first?.providerPositionHistoryKey).toBe(second?.providerPositionHistoryKey);
    expect(stableProviderFingerprint({ b: "2", a: "1" })).toBe(stableProviderFingerprint({ a: "1", b: "2" }));
  });
});

describe("provider ledger persistence and sync", () => {
  it("pages position histories with a stable keyset cursor", () => {
    const { db, executor } = memoryExecutor();
    const baseTime = Date.parse(observedAt);
    for (let index = 0; index < 3; index += 1) {
      const opening = new Date(baseTime + index * 1_000).toISOString();
      const closing = new Date(baseTime + index * 1_000 + 500).toISOString();
      const history = normalizeProviderPositionHistory(positionHistoryFixture({ positionId: `page-${index + 1}`, createdTime: opening, updatedTime: closing }), observedAt)!;
      upsertProviderPositionHistory(executor, history, observedAt);
    }
    const first = loadProviderPositionHistoriesPage(executor, category, null, 2);
    const second = loadProviderPositionHistoriesPage(executor, category, first.nextCursor, 2);
    expect(first.histories.map((history) => history.providerPositionHistoryId)).toEqual(["page-1", "page-2"]);
    expect(first.hasMore).toBe(true);
    expect(second.histories.map((history) => history.providerPositionHistoryId)).toEqual(["page-3"]);
    expect(second.hasMore).toBe(false);
    db.close();
  });

  it("loads lifecycle evidence in bounded batches rather than one SQL round trip per candidate", () => {
    const { db, executor, queries } = memoryExecutor();
    const makeRequest = (index: number) => ({
      requestId: `batch-${index}`,
      history: null,
      experience: { experienceId: `experience-${index}`, symbol: "CRCLUSDT", positionSide: "LONG", action: "OPEN_LONG", entryDecisionId: `decision-${index}` } as never,
    });
    const countEvidenceQueries = (count: number) => {
      const before = queries.length;
      const evidence = loadProviderLifecycleEvidenceBatch(executor, category, Array.from({ length: count }, (_, index) => makeRequest(index)));
      expect(evidence.size).toBe(count);
      expect([...evidence.values()].every((item) => item.evidenceComplete)).toBe(true);
      return queries.slice(before).filter((query) => /^(SELECT|WITH)/i.test(query.trimStart())).length;
    };
    expect(countEvidenceQueries(1)).toBe(3);
    expect(countEvidenceQueries(25)).toBe(6);
    db.close();
  });

  it("increments a durable sync revision even when the provider timestamp is unchanged", () => {
    const { db, executor } = memoryExecutor();
    const state = { category: "SPOT", checkpoints: {}, lastSuccessfulSyncAt: observedAt, lastReconciliationAt: null, lastError: null, updatedAt: observedAt };
    saveProviderSyncState(executor, state);
    const firstRevision = loadProviderSyncState(executor, "SPOT")?.revision;
    saveProviderSyncState(executor, state);
    const secondRevision = loadProviderSyncState(executor, "SPOT")?.revision;
    expect(firstRevision).toBe(1);
    expect(secondRevision).toBe(2);
    db.close();
  });

  it("bounds financial-record flow reads and reports truncation instead of trusting a partial sum", () => {
    const { db, executor } = memoryExecutor();
    const insert = db.prepare("INSERT INTO provider_financial_records (provider_record_key, provider_record_id, category, type, coin, amount, fee, provider_timestamp, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (let index = 1; index <= 2; index += 1) {
      const timestamp = `2026-09-0${index}T00:00:00.000Z`;
      insert.run(`flow-${index}`, `flow-${index}`, "USDT-FUTURES", "TRANSFER_IN", "USDT", "1", "0", timestamp, "UNATTRIBUTED", "{}", timestamp, timestamp);
    }
    const result = loadProviderFinancialRecordsSinceCategories(executor, PROVIDER_FINANCIAL_CATEGORIES, "2026-09-01T00:00:00.000Z", 1);
    expect(result.records).toHaveLength(1);
    expect(result.truncated).toBe(true);
    db.close();
  });

  it("adds a sync revision to legacy provider-sync state without losing checkpoints", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE provider_sync_state (category TEXT PRIMARY KEY, checkpoint_json TEXT NOT NULL, last_successful_sync_at TEXT, last_reconciliation_at TEXT, last_error TEXT, updated_at TEXT NOT NULL)");
    db.prepare("INSERT INTO provider_sync_state (category, checkpoint_json, last_successful_sync_at, last_reconciliation_at, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("MARGIN", JSON.stringify({ financialRecords: { windowStart: observedAt, windowEnd: observedAt } }), observedAt, null, null, observedAt);
    const executor = memoryExecutor(db).executor;
    const legacy = loadProviderSyncState(executor, "MARGIN");
    expect(legacy).toMatchObject({ category: "MARGIN", revision: 0, checkpoints: { financialRecords: { windowStart: observedAt, windowEnd: observedAt } } });
    saveProviderSyncState(executor, legacy!);
    expect(loadProviderSyncState(executor, "MARGIN")?.revision).toBe(1);
    db.close();
  });

  it("upserts duplicate provider records without creating duplicates", () => {
    const { db, executor } = memoryExecutor();
    const order = normalizeProviderOrder(orderFixture(), "DARWIN", observedAt)!;
    const fill = normalizeProviderFill(fillFixture(), "DARWIN", observedAt)!;
    const history = normalizeProviderPositionHistory(positionHistoryFixture(), observedAt)!;
    const financial = normalizeProviderFinancialRecord(financialFixture(), observedAt)!;

    upsertProviderOrder(executor, order, observedAt);
    upsertProviderOrder(executor, { ...order, orderStatus: "filled" }, "2026-09-22T00:01:00.000Z");
    upsertProviderFill(executor, fill, observedAt);
    upsertProviderFill(executor, { ...fill, execPnl: "0.01" }, "2026-09-22T00:01:00.000Z");
    upsertProviderPositionHistory(executor, history, observedAt);
    upsertProviderPositionHistory(executor, { ...history, positionPnl: "17" }, "2026-09-22T00:01:00.000Z");
    upsertProviderFinancialRecord(executor, financial, observedAt);
    upsertProviderFinancialRecord(executor, { ...financial, amount: "313" }, "2026-09-22T00:01:00.000Z");

    expect((db.prepare("SELECT COUNT(*) AS count FROM provider_orders").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM provider_fills").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM provider_position_history").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM provider_financial_records").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT exec_pnl FROM provider_fills WHERE exec_id = 'fill-1'").get() as { exec_pnl: string }).exec_pnl).toBe("0.01");
    expect((db.prepare("SELECT amount FROM provider_financial_records WHERE provider_record_key = 'USDT-FUTURES:financial-1'").get() as { amount: string }).amount).toBe("313");
  });

  it("persists historical orders that reuse a client OID", () => {
    const { db, executor } = memoryExecutor();
    const first = normalizeProviderOrder(orderFixture({ orderId: "reuse-1", createdTime: "1730181468493", updatedTime: "1730181468593" }), "PROVIDER_EXTERNAL", observedAt)!;
    const second = normalizeProviderOrder(orderFixture({ orderId: "reuse-2", createdTime: "1730182468493", updatedTime: "1730182468593" }), "PROVIDER_EXTERNAL", observedAt)!;

    upsertProviderOrder(executor, first, observedAt);
    upsertProviderOrder(executor, second, "2026-09-22T00:01:00.000Z");

    expect((db.prepare("SELECT COUNT(*) AS count FROM provider_orders WHERE category = 'USDT-FUTURES' AND client_oid = 'paper-cycle-1'").get() as { count: number }).count).toBe(2);
  });

  it("attributes DARWIN and external orders using durable idempotency, not prefixes", () => {
    const { db, executor } = memoryExecutor();
    recordIdempotency(executor, "paper-cycle-1", "cycle-1", "decision-1", observedAt);
    recordProviderOrderReference(executor, "paper-cycle-1", "order-1");
    const darwin = normalizeProviderOrder(orderFixture(), resolveProviderOrigin(executor, "order-1", "paper-cycle-1"), observedAt)!;
    const external = normalizeProviderOrder(orderFixture({ orderId: "order-2", clientOid: "paper-not-in-idempotency" }), resolveProviderOrigin(executor, "order-2", "paper-not-in-idempotency", "PROVIDER_EXTERNAL"), observedAt)!;
    upsertProviderOrder(executor, darwin, observedAt);
    upsertProviderOrder(executor, external, observedAt);

    expect(resolveProviderOrigin(executor, "order-1", null)).toBe("DARWIN");
    expect((db.prepare("SELECT origin FROM provider_orders WHERE provider_order_id = 'order-1'").get() as { origin: string }).origin).toBe("DARWIN");
    expect((db.prepare("SELECT origin FROM provider_orders WHERE provider_order_id = 'order-2'").get() as { origin: string }).origin).toBe("PROVIDER_EXTERNAL");
  });

  it("inherits exact provider-order origin for fills and leaves unknown fills unattributed", () => {
    const { executor } = memoryExecutor();
    const externalOrder = normalizeProviderOrder(orderFixture({ orderId: "ext-order-1", clientOid: null }), "PROVIDER_EXTERNAL", observedAt)!;
    upsertProviderOrder(executor, externalOrder, observedAt);
    recordIdempotency(executor, "paper-cycle-1", "cycle-1", "decision-1", observedAt);
    recordProviderOrderReference(executor, "paper-cycle-1", "darwin-order-1");
    const darwinOrder = normalizeProviderOrder(orderFixture({ orderId: "darwin-order-1" }), "DARWIN", observedAt)!;
    upsertProviderOrder(executor, darwinOrder, observedAt);

    const externalFill = normalizeProviderFill(fillFixture({ execId: "ext-fill-1", orderId: "ext-order-1", clientOid: null }), resolveProviderOrigin(executor, "ext-order-1", null), observedAt)!;
    const darwinFill = normalizeProviderFill(fillFixture({ execId: "darwin-fill-1", orderId: "darwin-order-1", clientOid: null }), resolveProviderOrigin(executor, "darwin-order-1", null), observedAt)!;
    const unknownFill = normalizeProviderFill(fillFixture({ execId: "unknown-fill-1", orderId: "unknown-order-1", clientOid: null }), resolveProviderOrigin(executor, "unknown-order-1", null), observedAt)!;

    expect(externalFill.origin).toBe("PROVIDER_EXTERNAL");
    expect(darwinFill.origin).toBe("DARWIN");
    expect(unknownFill.origin).toBe("UNATTRIBUTED");
  });

  it("backfills all resources through bounded pages and is idempotent on repeat", async () => {
    const { db, executor } = memoryExecutor();
    const calls: Array<{ resource: string; cursor?: string }> = [];
    const recordCall = (resource: string, cursor: string | undefined): void => {
      calls.push(cursor ? { resource, cursor } : { resource });
    };
    const client: ProviderLedgerReadClient = {
      async getOrderHistoryRead(params) { recordCall("orders", params.cursor); return params.cursor ? { list: [], cursor: null } : { list: [orderFixture()], cursor: null }; },
      async getFillHistoryWindowRead(params) { recordCall("fills", params.cursor); return params.cursor ? { list: [], cursor: null } : { list: [fillFixture()], cursor: null }; },
      async getPositionHistoryRead(params) { recordCall("positions", params.cursor); return params.cursor ? { list: [], cursor: null } : { list: [positionHistoryFixture()], cursor: null }; },
      async getFinancialRecordsRead(params) { recordCall("financial", params.cursor); return params.cursor ? { list: [], cursor: null } : { list: [financialFixture()], cursor: null }; },
    };

    const first = await syncProviderLedger(client, executor, { category, mode: "recent", now: new Date("2026-09-22T00:00:00.000Z"), recentWindowMs: 60 * 60 * 1000 });
    const second = await syncProviderLedger(client, executor, { category, mode: "recent", now: new Date("2026-09-22T00:00:00.000Z"), recentWindowMs: 60 * 60 * 1000 });

    expect(first.status).toBe("SUCCESS");
    expect(second.status).toBe("SUCCESS");
    expect(calls.map((call) => call.resource)).toEqual(["orders", "fills", "positions", "financial", "orders", "fills", "positions", "financial"]);
    expect((db.prepare("SELECT COUNT(*) AS count FROM provider_orders").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM provider_fills").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM provider_position_history").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM provider_financial_records").get() as { count: number }).count).toBe(1);
    expect(loadProviderSyncState(executor, category)?.lastSuccessfulSyncAt).toBe("2026-09-22T00:00:00.000Z");
  });

  it("supports financial-record-only category sync without touching trading lifecycle resources", async () => {
    const { executor } = memoryExecutor();
    const calls: string[] = [];
    const client: ProviderLedgerReadClient = {
      async getOrderHistoryRead() { calls.push("orders"); throw new Error("MUST_NOT_SYNC_ORDERS"); },
      async getFillHistoryWindowRead() { calls.push("fills"); throw new Error("MUST_NOT_SYNC_FILLS"); },
      async getPositionHistoryRead() { calls.push("positions"); throw new Error("MUST_NOT_SYNC_POSITIONS"); },
      async getFinancialRecordsRead(params) { calls.push(`financial:${params.category}`); return { list: [financialFixture({ category: params.category })], cursor: null }; },
    };
    const result = await syncProviderLedger(client, executor, {
      category: "SPOT",
      mode: "recent",
      financialRecordsOnly: true,
      now: new Date("2026-09-22T00:00:00.000Z"),
      recentWindowMs: 60 * 60 * 1000,
    });
    expect(result.status).toBe("SUCCESS");
    expect(calls).toEqual(["financial:SPOT"]);
    expect(providerLedgerDiagnostics(executor, "SPOT").counts.financialRecords).toBe(1);
    expect(providerLedgerDiagnostics(executor, "SPOT").counts.orders).toBe(0);
  });

  it("syncs account financial records for exactly the six documented categories", async () => {
    const { executor } = memoryExecutor();
    const financialCategories: string[] = [];
    const lifecycleResources: string[] = [];
    const client: ProviderLedgerReadClient = {
      async getOrderHistoryRead(params) { lifecycleResources.push(`orders:${params.category}`); return { list: [], cursor: null }; },
      async getFillHistoryWindowRead(params) { lifecycleResources.push(`fills:${params.category}`); return { list: [], cursor: null }; },
      async getPositionHistoryRead(params) { lifecycleResources.push(`positions:${params.category}`); return { list: [], cursor: null }; },
      async getFinancialRecordsRead(params) { financialCategories.push(params.category); return { list: [], cursor: null }; },
    };
    for (const syncCategory of PROVIDER_FINANCIAL_CATEGORIES) {
      const result = await syncProviderLedger(client, executor, { category: syncCategory, mode: "recent", financialRecordsOnly: syncCategory !== "USDT-FUTURES", now: new Date(observedAt), recentWindowMs: 60 * 60 * 1000 });
      expect(result.status).toBe("SUCCESS");
    }
    expect(financialCategories).toEqual(PROVIDER_FINANCIAL_CATEGORIES);
    expect(lifecycleResources).toEqual(["orders:USDT-FUTURES", "fills:USDT-FUTURES", "positions:USDT-FUTURES"]);
    for (const syncCategory of PROVIDER_FINANCIAL_CATEGORIES) {
      expect(providerLedgerDiagnostics(executor, syncCategory).sync).toMatchObject({ lastSuccessfulSyncAt: observedAt, lastError: null });
    }
  });

  it("backfills six-category financial coverage from the preserved baseline and retains coverage through recent sync", async () => {
    const { executor } = memoryExecutor();
    const baselineAt = "2026-08-01T00:00:00.000Z";
    const now = new Date("2026-09-22T00:00:00.000Z");
    const financialCalls: string[] = [];
    const lifecycleCalls: string[] = [];
    const client: ProviderLedgerReadClient = {
      async getOrderHistoryRead(params) { lifecycleCalls.push(`orders:${params.category}`); return { list: [], cursor: null }; },
      async getFillHistoryWindowRead(params) { lifecycleCalls.push(`fills:${params.category}`); return { list: [], cursor: null }; },
      async getPositionHistoryRead(params) { lifecycleCalls.push(`positions:${params.category}`); return { list: [], cursor: null }; },
      async getFinancialRecordsRead(params) { financialCalls.push(params.category); return { list: [financialFixture({ category: params.category })], cursor: null }; },
    };

    for (const syncCategory of PROVIDER_FINANCIAL_CATEGORIES) {
      const result = await syncProviderLedger(client, executor, {
        category: syncCategory,
        mode: "backfill",
        coverageStartAt: baselineAt,
        financialRecordsOnly: syncCategory !== "USDT-FUTURES",
        now,
      });
      expect(result.status).toBe("SUCCESS");
    }

    expect([...new Set(financialCalls)]).toEqual(PROVIDER_FINANCIAL_CATEGORIES);
    expect(financialCalls).toHaveLength(PROVIDER_FINANCIAL_CATEGORIES.length * 2);
    expect(lifecycleCalls.every((resource) => resource.endsWith(":USDT-FUTURES"))).toBe(true);
    for (const syncCategory of PROVIDER_FINANCIAL_CATEGORIES) {
      expect(loadProviderSyncState(executor, syncCategory)?.financialRecordCoverage).toEqual({
        coveredFrom: baselineAt,
        coveredThrough: now.toISOString(),
        lastSuccessfulSyncAt: now.toISOString(),
        lastError: null,
      });
    }

    const recent = await syncProviderLedger(client, executor, {
      category: "OTHER",
      mode: "recent",
      financialRecordsOnly: true,
      now: new Date("2026-09-22T01:00:00.000Z"),
      recentWindowMs: 60 * 60 * 1000,
    });
    expect(recent.status).toBe("SUCCESS");
    expect(loadProviderSyncState(executor, "OTHER")?.financialRecordCoverage?.coveredFrom).toBe(baselineAt);
  });

  it("uses bounded overlapping windows for backfill", async () => {
    const { executor } = memoryExecutor();
    const windows: Array<{ start: number; end: number }> = [];
    const client: ProviderLedgerReadClient = {
      async getOrderHistoryRead(params) { windows.push({ start: Number(params.startTime), end: Number(params.endTime) }); return { list: [], cursor: null }; },
      async getFillHistoryWindowRead() { return { list: [], cursor: null }; },
      async getPositionHistoryRead() { return { list: [], cursor: null }; },
      async getFinancialRecordsRead() { return { list: [], cursor: null }; },
    };
    const now = new Date("2026-09-22T00:00:00.000Z").getTime();

    const result = await syncProviderLedger(client, executor, { category, mode: "backfill", now: new Date(now), initialLookbackMs: 61 * 24 * 60 * 60 * 1000, overlapMs: 60 * 60 * 1000 });

    expect(result.status).toBe("SUCCESS");
    expect(windows.length).toBeGreaterThan(1);
    expect(windows.every((window) => window.end - window.start <= 30 * 24 * 60 * 60 * 1000)).toBe(true);
    expect(windows[1]?.start).toBeLessThan(windows[0]?.end ?? 0);
  });

  it("keeps a safety margin inside the provider's 90-day retention boundary", async () => {
    const { executor } = memoryExecutor();
    const starts: string[] = [];
    const client: ProviderLedgerReadClient = {
      async getOrderHistoryRead(params) { starts.push(params.startTime ?? ""); return { list: [], cursor: null }; },
      async getFillHistoryWindowRead() { return { list: [], cursor: null }; },
      async getPositionHistoryRead() { return { list: [], cursor: null }; },
      async getFinancialRecordsRead() { return { list: [], cursor: null }; },
    };
    const now = new Date("2026-09-23T01:53:46.904Z");
    await syncProviderLedger(client, executor, { category, mode: "backfill", now });

    expect(starts[0]).toBe(String(now.getTime() - 90 * 24 * 60 * 60 * 1000 + 60_000));
  });

  it("retains completed resource checkpoints when a later resource fails", async () => {
    const { executor } = memoryExecutor();
    const client: ProviderLedgerReadClient = {
      async getOrderHistoryRead() { return { list: [orderFixture()], cursor: null }; },
      async getFillHistoryWindowRead() { return { list: [fillFixture()], cursor: null }; },
      async getPositionHistoryRead() { return { list: [positionHistoryFixture()], cursor: null }; },
      async getFinancialRecordsRead() { throw new Error("FINANCIAL_PROVIDER_UNAVAILABLE"); },
    };

    const result = await syncProviderLedger(client, executor, { category, mode: "recent", now: new Date("2026-09-22T00:00:00.000Z"), recentWindowMs: 60 * 60 * 1000 });
    const state = loadProviderSyncState(executor, category);

    expect(result.status).toBe("PARTIAL");
    expect(state?.lastSuccessfulSyncAt).toBeNull();
    expect(state?.lastError).toContain("FINANCIAL_PROVIDER_UNAVAILABLE");
    expect(state?.checkpoints.historyOrders?.windowEnd).toBe("2026-09-22T00:00:00.000Z");
    expect(state?.checkpoints.financialRecords).toBeUndefined();
  });


  it("protects against a repeated cursor", async () => {
    const { executor } = memoryExecutor();
    const client: ProviderLedgerReadClient = {
      async getOrderHistoryRead() { return { list: [orderFixture()], cursor: "same-cursor" }; },
      async getFillHistoryWindowRead() { return { list: [], cursor: null }; },
      async getPositionHistoryRead() { return { list: [], cursor: null }; },
      async getFinancialRecordsRead() { return { list: [], cursor: null }; },
    };

    const result = await syncProviderLedger(client, executor, { category, mode: "recent", now: new Date("2026-09-22T00:00:00.000Z"), recentWindowMs: 60 * 60 * 1000 });

    expect(result.status).toBe("PARTIAL");
    expect(result.errors.some((error) => error.includes("PROVIDER_CURSOR_REPEATED"))).toBe(true);
  });

  it("derives a cursor from the last provider row when the response omits one", async () => {
    const { executor } = memoryExecutor();
    const cursors: Array<string | undefined> = [];
    const client: ProviderLedgerReadClient = {
      async getOrderHistoryRead(params) { cursors.push(params.cursor); return params.cursor ? { list: [], cursor: null } : { list: [orderFixture()] }; },
      async getFillHistoryWindowRead() { return { list: [], cursor: null }; },
      async getPositionHistoryRead() { return { list: [], cursor: null }; },
      async getFinancialRecordsRead() { return { list: [], cursor: null }; },
    };

    const result = await syncProviderLedger(client, executor, { category, mode: "recent", now: new Date("2026-09-22T00:00:00.000Z"), recentWindowMs: 60 * 60 * 1000 });

    expect(result.status).toBe("SUCCESS");
    expect(cursors).toEqual([undefined, "order-1"]);
  });

  it("does not checkpoint an unexpected provider page shape", async () => {
    const { executor } = memoryExecutor();
    const client: ProviderLedgerReadClient = {
      async getOrderHistoryRead() { return { unexpected: true }; },
      async getFillHistoryWindowRead() { return { list: [], cursor: null }; },
      async getPositionHistoryRead() { return { list: [], cursor: null }; },
      async getFinancialRecordsRead() { return { list: [], cursor: null }; },
    };

    const result = await syncProviderLedger(client, executor, { category, mode: "recent", now: new Date("2026-09-22T00:00:00.000Z"), recentWindowMs: 60 * 60 * 1000 });
    const state = loadProviderSyncState(executor, category);

    expect(result.status).toBe("PARTIAL");
    expect(result.errors.some((error) => error.includes("INVALID_PROVIDER_PAGE"))).toBe(true);
    expect(state?.lastSuccessfulSyncAt).toBeNull();
  });

  it("returns the most recently closed lifecycle rows in a bounded window", () => {
    const { executor } = memoryExecutor();
    for (const [id, closedAt] of [["old", "1730190000000"], ["new", "1730300000000"]] as const) {
      const history = normalizeProviderPositionHistory(positionHistoryFixture({ positionId: id, createdTime: "1730181468493", updatedTime: closedAt }), observedAt)!;
      upsertProviderPositionHistory(executor, history, observedAt);
    }

    const rows = loadRecentProviderPositionHistories(executor, category, 1);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerPositionHistoryId).toBe("new");
  });

  it("uses bounded indexes for provider identity lookups", () => {
    const { db } = memoryExecutor();
    const identityPlan = db.prepare("EXPLAIN QUERY PLAN SELECT provider_order_id FROM idempotency WHERE provider_order_id = ? LIMIT 1").all("order-1") as Array<{ detail: string }>;
    const historyPlan = db.prepare("EXPLAIN QUERY PLAN SELECT provider_position_history_id FROM provider_position_history WHERE category = ? AND provider_position_history_id = ? LIMIT 1").all(category, "position-1") as Array<{ detail: string }>;

    expect(identityPlan.map((row) => row.detail).join(" ")).toContain("idempotency_provider_order_idx");
    expect(historyPlan.map((row) => row.detail).join(" ")).toContain("provider_position_history_category_id_idx");
  });

  it("reports bounded diagnostics without exposing raw provider payloads", () => {
    const { executor, queries } = memoryExecutor();
    const order = normalizeProviderOrder(orderFixture(), "DARWIN", observedAt)!;
    const fill = normalizeProviderFill(fillFixture(), "DARWIN", observedAt)!;
    upsertProviderOrder(executor, order, observedAt);
    upsertProviderFill(executor, fill, observedAt);
    upsertProviderPositionHistory(executor, normalizeProviderPositionHistory(positionHistoryFixture(), observedAt)!, observedAt);
    upsertProviderFinancialRecord(executor, normalizeProviderFinancialRecord(financialFixture(), observedAt)!, observedAt);
    upsertProviderOrder(executor, normalizeProviderOrder(orderFixture({ orderId: "external", clientOid: "external-1" }), "PROVIDER_EXTERNAL", observedAt)!, observedAt);

    const queryOffset = queries.length;
    const diagnostics = providerLedgerDiagnostics(executor, category);
    const diagnosticQueries = queries.slice(queryOffset).filter((query) => /FROM provider_(orders|fills|position_history|financial_records)/.test(query));

    expect(diagnostics.counts).toEqual({ orders: 2, fills: 1, positionHistory: 1, financialRecords: 1 });
    expect(diagnosticQueries).toHaveLength(4);
    expect(diagnostics.origins).toEqual({ DARWIN: 2, PROVIDER_EXTERNAL: 1, UNATTRIBUTED: 2 });
    expect(JSON.stringify(diagnostics)).not.toContain("order-1");
  });
});
