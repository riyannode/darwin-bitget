import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  normalizeProviderFill,
  normalizeProviderFinancialRecord,
  normalizeProviderOrder,
  normalizeProviderPositionHistory,
  providerTimestampIso,
  stableProviderFingerprint,
} from "../src/bitget/provider-ledger.js";
import { syncProviderLedger, type ProviderLedgerReadClient } from "../src/bitget/provider-sync.js";
import {
  loadProviderSyncState,
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

function memoryExecutor(): { db: DatabaseSync; executor: SqlExecutor } {
  const db = new DatabaseSync(":memory:");
  const executor: SqlExecutor = {
    sql<T>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] {
      const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
      const sqliteValues = values.map((value) => typeof value === "boolean" ? (value ? 1 : 0) : value) as (string | number | null)[];
      if (query.trimStart().toUpperCase().startsWith("SELECT")) return db.prepare(query).all(...sqliteValues) as T[];
      db.prepare(query).run(...sqliteValues);
      return [];
    },
  };
  ensureStorage(executor);
  return { db, executor };
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

  it("reports bounded diagnostics without exposing raw provider payloads", () => {
    const { executor } = memoryExecutor();
    const order = normalizeProviderOrder(orderFixture(), "DARWIN", observedAt)!;
    const fill = normalizeProviderFill(fillFixture(), "DARWIN", observedAt)!;
    upsertProviderOrder(executor, order, observedAt);
    upsertProviderFill(executor, fill, observedAt);
    upsertProviderPositionHistory(executor, normalizeProviderPositionHistory(positionHistoryFixture(), observedAt)!, observedAt);
    upsertProviderFinancialRecord(executor, normalizeProviderFinancialRecord(financialFixture(), observedAt)!, observedAt);
    upsertProviderOrder(executor, normalizeProviderOrder(orderFixture({ orderId: "external", clientOid: "external-1" }), "PROVIDER_EXTERNAL", observedAt)!, observedAt);

    const diagnostics = providerLedgerDiagnostics(executor, category);

    expect(diagnostics.counts).toEqual({ orders: 2, fills: 1, positionHistory: 1, financialRecords: 1 });
    expect(diagnostics.origins).toEqual({ DARWIN: 2, PROVIDER_EXTERNAL: 1, UNATTRIBUTED: 2 });
    expect(JSON.stringify(diagnostics)).not.toContain("order-1");
  });
});
