import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { loadProviderLifecycleEvidence, loadProviderSyncState, saveProviderSyncState } from "../src/storage/provider-ledger.js";
import { classifyProviderLifecycle } from "../src/trading/provider-lifecycle-reconciliation.js";
import { hasEvent, loadAllEvents, loadAllExperiences, loadPositionContext, persistProviderLifecycleRepair, saveEvent, saveExperience, saveJournal, savePositionContext } from "../src/storage/store.js";
import { TraderAgent, resolveProviderTradeFacts } from "../src/agent/agent.js";
import { BitgetClient } from "../src/bitget/client.js";
import { PROVIDER_FINANCIAL_CATEGORIES } from "../src/bitget/provider-sync.js";
import { rebuildProviderPerformance } from "../src/trading/provider-performance.js";
import type { PerformanceAggregate } from "../src/trading/performance.js";
import type { PositionContext, TradeExperience, TradingJournal } from "../src/types.js";

vi.mock("agents", () => ({ Agent: class {} }));
vi.mock("../src/trading/execution.js", async () => {
  const actual = await vi.importActual<typeof import("../src/trading/execution.js")>("../src/trading/execution.js");
  return { ...actual, executePaperOrder: vi.fn() };
});

import { executePaperOrder } from "../src/trading/execution.js";

const HISTORY_ID = "1485976014620573698";
const EXPERIENCE_ID = "80432b47-8fa1-4f41-af10-63e6ac4c55f6";
const ENTRY_DECISION_ID = "87a5c9bc-e24e-4b97-bcaf-c8417d0f6c11";
const OPENED_AT = "2026-09-21T17:03:30.661Z";
const OPEN_FILL_AT = "2026-09-21T17:03:30.659Z";
const LOCAL_ENTRY_AT = "2026-09-21T17:03:32.134Z";
const CLOSED_AT = "2026-09-22T01:43:06.332Z";
const OWNER_TOKEN = ["owner", "test", "token"].join("-");

function memoryExecutor(db = new DatabaseSync(":memory:")): { db: DatabaseSync; executor: SqlExecutor; queries: string[] } {
  const queries: string[] = [];
  const executor: SqlExecutor = {
    sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
      const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
      queries.push(query);
      const params = values.map((value) => typeof value === "boolean" ? Number(value) : value) as (string | number | null)[];
      const normalizedQuery = query.trimStart().toUpperCase();
      if (normalizedQuery.startsWith("SELECT") || normalizedQuery.startsWith("WITH")) return db.prepare(query).all(...params) as T[];
      db.prepare(query).run(...params);
      return [];
    },
  };
  ensureStorage(executor);
  return { db, executor, queries };
}

function openExperience(): TradeExperience {
  return {
    experienceId: EXPERIENCE_ID, symbol: "SAMSUNGUSDT", positionSide: "LONG", action: "OPEN_LONG", entryDecisionId: ENTRY_DECISION_ID,
    entryPrice: "198.02", entryTime: LOCAL_ENTRY_AT, exitDecisionId: "", exitPrice: "0", exitTime: "", selectedLeverage: "3",
    marginAllocationPct: "10", marginAllocated: "100", positionNotional: "1490.13", realizedPnl: "19.1364", realizedPnlPct: "0",
    maximumFavorableExcursion: "0", maximumAdverseExcursion: "0", drawdownContribution: "0", liquidationDistance: "0",
    entryThesis: "preserve this thesis", exitThesis: "", evidenceAtEntry: ["entry-proof"], evidenceAtExit: [], lessonsUsed: ["lesson-1"],
    marketContext: "preserve context", outcomeStatus: "OPEN", lastAction: "REDUCE",
  };
}

function positionContext(): PositionContext {
  const reasoning = { action: "OPEN_LONG" as const, thesis: "preserve this thesis", strategyThesis: "strategy", supportingFactors: ["support"], riskFactors: ["risk"], evidenceUsed: ["evidence"], lessonsUsed: ["lesson-1"], confidence: 0.8, cycleId: "cycle-entry", decisionId: ENTRY_DECISION_ID, createdAt: OPENED_AT, entryPrice: "198.02", entryTime: LOCAL_ENTRY_AT, experienceId: EXPERIENCE_ID };
  return { symbol: "SAMSUNGUSDT", positionSide: "LONG", experienceId: EXPERIENCE_ID, entryDecisionId: ENTRY_DECISION_ID, entryReasoning: reasoning, managementEvents: [{ ...reasoning, action: "REDUCE", decisionId: "management-1" }], updatedAt: OPENED_AT };
}

const journal: TradingJournal = { cycleId: "cycle-entry", agentVersion: "test", promptVersion: "test", model: "test", mode: "AUTONOMOUS", startedAt: OPENED_AT, retrievedLessons: [], createdLessons: [] };

function insertProviderEvidence(executor: SqlExecutor): void {
  const run = (sql: string, ...values: (string | null)[]) => executor.sql(sql.split("?") as unknown as TemplateStringsArray, ...values);
  run("INSERT INTO idempotency (client_order_id, cycle_id, decision_id, provider_order_id, created_at) VALUES (?, ?, ?, ?, ?)", "darwin-entry-oid", "cycle-entry", ENTRY_DECISION_ID, "provider-entry-order", OPENED_AT);
  run("INSERT INTO provider_position_history (provider_position_history_key, provider_position_history_id, category, symbol, position_side, opening_time, closing_time, avg_entry_price, avg_exit_price, open_total_pos, close_total_pos, cum_realised_pnl, net_profit, closing_quantity, open_fee_total, close_fee_total, total_funding, cash_dividend, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "key-1", HISTORY_ID, "USDT-FUTURES", "SAMSUNGUSDT", "LONG", OPENED_AT, CLOSED_AT, "198.02", "202.66", "7.51", "7.51", "34.8487", "33.19485709", "7.51", "-0.89227812", "-0.91318734", "0.15162255", "0", "UNATTRIBUTED", "{}", CLOSED_AT, CLOSED_AT);
  const order = (id: string, oid: string, side: string, tradeSide: string, quantity: string, time: string) => run("INSERT INTO provider_orders (provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, qty, cum_exec_qty, order_status, created_time, updated_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, oid, "USDT-FUTURES", "SAMSUNGUSDT", side, "long", tradeSide, quantity, quantity, "filled", time, time, "DARWIN", "{}", time, time);
  const fill = (id: string, oid: string, side: string, tradeSide: string, quantity: string, time: string) => run("INSERT INTO provider_fills (exec_id, provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, exec_qty, exec_price, created_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", `fill-${id}`, id, oid, "USDT-FUTURES", "SAMSUNGUSDT", side, "long", tradeSide, quantity, "198.02", time, "DARWIN", "{}", time, time);
  order("provider-entry-order", "darwin-entry-oid", "buy", "open", "7.51", OPEN_FILL_AT);
  fill("provider-entry-order", "darwin-entry-oid", "buy", "open", "7.51", OPEN_FILL_AT);
  ["2.47", "1.66", "1.11", "1.13", "0.57", "0.57"].forEach((quantity, index) => {
    const id = `provider-close-${index + 1}`;
    const oid = `darwin-close-${index + 1}`;
    const time = `2026-09-21T${String(18 + index).padStart(2, "0")}:00:00.000Z`;
    order(id, oid, "sell", "close", quantity, time);
    fill(id, oid, "sell", "close", quantity, time);
  });
}

function transaction<T>(db: DatabaseSync, closure: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = closure();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function fakeAgent(executor: SqlExecutor, db: DatabaseSync, paused: boolean) {
  return {
    sql: executor.sql,
    env: { TRADING_MODE: "PAPER", PAPER_ONLY: "true", AGENT_MODE: "AUTONOMOUS", BITGET_CATEGORY: "USDT-FUTURES", OWNER_CONTROL_TOKEN: OWNER_TOKEN },
    state: { paused, runtimeStatus: paused ? "PAUSED" : "ONLINE" },
    ctx: { storage: { transactionSync: <T>(closure: () => T) => { db.exec("BEGIN IMMEDIATE"); try { const value = closure(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; } } } },
    ensureActivePolicy: () => ({ paperOnly: true, maxSinglePositionMarginPct: "30", maxLeverage: "5", maxDailyDrawdownPct: "10", drawdownCooldownMinutes: 60, scanIntervalMinutes: 5, emergencyStop: false }),
    repairProviderClosedLifecycle: TraderAgent.prototype.repairProviderClosedLifecycle,
    getTradeHistory: (TraderAgent.prototype as unknown as { getTradeHistory: (url: URL) => Promise<Response> }).getTradeHistory,
    getDashboardSnapshot: TraderAgent.prototype.getDashboardSnapshot,
    getSchedulerDiagnostics: async () => ({ nextScanAt: null, nextScanStale: false, configuredIntervalMinutes: 5, matchingScheduleCount: 0, schedulerHealthy: true }),
    isProviderSyncSchedulerHealthy: async () => false,
    persistPerformanceEquity: (TraderAgent.prototype as unknown as { persistPerformanceEquity: (equity: string, observedAt: string) => void }).persistPerformanceEquity,
    performanceWithEquity: (TraderAgent.prototype as unknown as { performanceWithEquity: (equity: string, observedAt: string) => PerformanceAggregate }).performanceWithEquity,
    onRequest: TraderAgent.prototype.onRequest,
  };
}

async function invokeRepair(agent: ReturnType<typeof fakeAgent>) {
  return agent.repairProviderClosedLifecycle.call(agent, EXPERIENCE_ID, HISTORY_ID);
}

async function invokeControl(agent: ReturnType<typeof fakeAgent>, authorized = true) {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorized) headers.set("authorization", `Bearer ${OWNER_TOKEN}`);
  return agent.onRequest.call(agent, new Request("https://example.test/control", {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "REPAIR_PROVIDER_CLOSED_LIFECYCLE", experienceId: EXPERIENCE_ID, providerPositionHistoryId: HISTORY_ID }),
  }));
}

afterEach(() => vi.restoreAllMocks());

describe("provider-first financial lifecycle resolution", () => {
  it("keeps a provider-confirmed closed DARWIN lifecycle in performance and trade history without TradeExperience or PositionContext", async () => {
    const { db, executor } = memoryExecutor();
    insertProviderEvidence(executor);
    const resolved = resolveProviderTradeFacts(executor, [], "USDT-FUTURES", []);
    expect(resolved.lifecycles).toContainEqual({ lifecycleId: HISTORY_ID, origin: "DARWIN", status: "CLOSED", netProfit: "33.19485709", closedAt: CLOSED_AT });
    expect(rebuildProviderPerformance(resolved.lifecycles)).toMatchObject({ closedTrades: 1, wins: 1, verifiedRealizedPnl: "33.19485709" });
    expect(resolved.providerOnlyHistories).toHaveLength(1);
    const agent = fakeAgent(executor, db, true);
    const providerRead = vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: CLOSED_AT } as never);
    const response = await agent.getTradeHistory.call(agent, new URL("https://example.test/trade-history?limit=25"));
    const body = await response.json() as { trades: Array<Record<string, unknown>>; journalDecisionLookupMigration: { status: string }; journalReasoningCoverage: string };
    expect(body.journalDecisionLookupMigration.status).toBe("PENDING");
    expect(body.journalReasoningCoverage).toBe("PARTIAL");
    expect(body.trades).toContainEqual(expect.objectContaining({ tradeId: `provider-history:${HISTORY_ID}`, status: "CLOSED", financialSource: "PROVIDER_LEDGER", origin: "DARWIN", realizedPnl: "33.19485709", entry: "198.02" }));
    const providerOnly = body.trades.find((trade) => trade.tradeId === `provider-history:${HISTORY_ID}`)!;
    expect(providerOnly.reasoningSource).toBe("UNATTRIBUTED");
    expect(providerOnly).not.toHaveProperty("entryReasoning");
    expect(providerRead).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("attaches only persisted journal reasoning to provider-only closed history when no experience exists", async () => {
    const { db, executor } = memoryExecutor();
    insertProviderEvidence(executor);
    saveJournal(executor, {
      ...journal,
      cycleId: "cycle-provider-history-reasoning",
      startedAt: OPENED_AT,
      decision: {
        decisionId: ENTRY_DECISION_ID,
        cycleId: "cycle-provider-history-reasoning",
        symbol: "SAMSUNGUSDT",
        positionSide: "LONG",
        action: "OPEN_LONG",
        marginAllocationPct: "10",
        leverage: "3",
        reductionPct: null,
        confidence: 0.8,
        thesis: "journal-persisted entry rationale",
        strategyThesis: "strategy rationale",
        supportingFactors: ["provider-confirmed factor"],
        riskFactors: [],
        evidenceUsed: ["journal-evidence"],
        lessonsUsed: [],
        createdAt: OPENED_AT,
      },
      executionResult: { providerOrderId: "journal-provider-order", clientOrderId: "journal-client-order" } as never,
    });
    const agent = fakeAgent(executor, db, true);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: CLOSED_AT } as never);
    const response = await agent.getTradeHistory.call(agent, new URL("https://example.test/trade-history?limit=25"));
    const body = await response.json() as { trades: Array<Record<string, unknown>> };
    const providerOnly = body.trades.find((trade) => trade.tradeId === `provider-history:${HISTORY_ID}`)!;
    expect(providerOnly).toMatchObject({
      reasoningSource: "DARWIN_PERSISTED",
      entryReasoning: expect.objectContaining({ thesis: "journal-persisted entry rationale" }),
      orderReference: "journal-provider-order",
    });
    db.close();
  });

  it("joins matching persisted position context for provider-only history without a local experience or journal", async () => {
    const { db, executor } = memoryExecutor();
    insertProviderEvidence(executor);
    savePositionContext(executor, positionContext());
    const agent = fakeAgent(executor, db, true);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: CLOSED_AT } as never);
    const response = await agent.getTradeHistory.call(agent, new URL("https://example.test/trade-history?limit=25"));
    const body = await response.json() as { trades: Array<Record<string, unknown>> };
    const providerOnly = body.trades.find((trade) => trade.tradeId === `provider-history:${HISTORY_ID}`)!;
    expect(providerOnly).toMatchObject({
      reasoningSource: "DARWIN_PERSISTED",
      entryReasoning: expect.objectContaining({ thesis: "preserve this thesis" }),
      managementEvents: [expect.objectContaining({ thesis: "preserve this thesis" })],
    });
    db.close();
  });

  it("keeps same-symbol fills with unknown position side from being silently dropped by batch reads", () => {
    const { db, executor } = memoryExecutor();
    insertProviderEvidence(executor);
    const run = (sql: string, ...values: (string | null)[]) => executor.sql(sql.split("?") as unknown as TemplateStringsArray, ...values);
    run("INSERT INTO provider_orders (provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, qty, cum_exec_qty, order_status, created_time, updated_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "unknown-side-order", "manual-unknown-side", "USDT-FUTURES", "SAMSUNGUSDT", "buy", null, "open", "0.25", "0.25", "filled", "2026-09-21T17:15:00.000Z", "2026-09-21T17:15:00.000Z", "UNATTRIBUTED", "{}", OPENED_AT, OPENED_AT);
    run("INSERT INTO provider_fills (exec_id, provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, exec_qty, exec_price, created_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "unknown-side-fill", "unknown-side-order", "manual-unknown-side", "USDT-FUTURES", "SAMSUNGUSDT", "buy", null, "open", "0.25", "198.02", "2026-09-21T17:15:00.000Z", "UNATTRIBUTED", "{}", OPENED_AT, OPENED_AT);
    const resolved = resolveProviderTradeFacts(executor, [], "USDT-FUTURES", []);
    expect(resolved.lifecycles).toEqual([]);
    expect(resolved.providerOnlyHistories).toEqual([]);
    db.close();
  });

  it("keeps a provider-live open position as an open trade without local lifecycle or PositionContext", async () => {
    const { db, executor } = memoryExecutor();
    insertProviderEvidence(executor);
    db.exec("DELETE FROM provider_position_history; DELETE FROM provider_fills WHERE trade_side = 'close'; DELETE FROM provider_orders WHERE trade_side = 'close';");
    const providerPosition = { symbol: "SAMSUNGUSDT", positionSide: "LONG", quantity: "7.51", entryPrice: "198.02", leverage: "4", marginAllocated: "371.28", notional: "1487.33", unrealizedPnl: "12.5", openedAt: OPENED_AT } as never;
    const resolved = resolveProviderTradeFacts(executor, [], "USDT-FUTURES", [providerPosition]);
    expect(rebuildProviderPerformance(resolved.lifecycles)).toMatchObject({ openTrades: 1, totalTrades: 1 });
    const agent = fakeAgent(executor, db, true);
    const providerRead = vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [providerPosition], portfolioEquity: "1000", observedAt: CLOSED_AT } as never);
    const response = await agent.getTradeHistory.call(agent, new URL("https://example.test/trade-history?limit=25"));
    const body = await response.json() as { trades: Array<Record<string, unknown>> };
    expect(body.trades).toContainEqual(expect.objectContaining({ tradeId: "provider-open:provider-entry-order", status: "OPEN", financialSource: "PROVIDER_LIVE", origin: "DARWIN", quantity: "7.51", entry: "198.02", leverage: "4", marginAllocated: "371.28", marginAllocationPct: "UNAVAILABLE", positionNotional: "1487.33", unrealizedPnl: "12.5", openedAt: OPENED_AT }));
    expect(body.trades[0]?.reasoningSource).toBe("UNATTRIBUTED");
    expect(providerRead).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("attaches provider-live journal reasoning only when the opening decision is persisted", async () => {
    const { db, executor } = memoryExecutor();
    insertProviderEvidence(executor);
    db.exec("DELETE FROM provider_position_history; DELETE FROM provider_fills WHERE trade_side = 'close'; DELETE FROM provider_orders WHERE trade_side = 'close';");
    saveJournal(executor, {
      ...journal,
      cycleId: "cycle-provider-live-reasoning",
      startedAt: OPENED_AT,
      decision: {
        decisionId: ENTRY_DECISION_ID,
        cycleId: "cycle-provider-live-reasoning",
        symbol: "SAMSUNGUSDT",
        positionSide: "LONG",
        action: "OPEN_LONG",
        marginAllocationPct: "10",
        leverage: "3",
        reductionPct: null,
        confidence: 0.8,
        thesis: "persisted live position thesis",
        strategyThesis: "persisted strategy thesis",
        supportingFactors: ["entry basis"],
        riskFactors: [],
        evidenceUsed: ["decision evidence"],
        lessonsUsed: [],
        createdAt: OPENED_AT,
      },
      executionResult: { providerOrderId: "provider-entry-order", clientOrderId: "darwin-entry-oid" } as never,
    });
    const providerPosition = { symbol: "SAMSUNGUSDT", positionSide: "LONG", quantity: "7.51", entryPrice: "198.02", leverage: "4", marginAllocated: "371.28", notional: "1487.33", unrealizedPnl: "12.5", openedAt: OPENED_AT } as never;
    const agent = fakeAgent(executor, db, true);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [providerPosition], portfolioEquity: "1000", observedAt: CLOSED_AT } as never);
    const response = await agent.getTradeHistory.call(agent, new URL("https://example.test/trade-history?limit=25"));
    const body = await response.json() as { trades: Array<Record<string, unknown>> };
    const liveTrade = body.trades.find((trade) => trade.tradeId === "provider-open:provider-entry-order")!;
    expect(liveTrade).toMatchObject({
      reasoningSource: "DARWIN_PERSISTED",
      entryReasoning: expect.objectContaining({ thesis: "persisted live position thesis" }),
      orderReference: "provider-entry-order",
    });
    db.close();
  });

  it("reconciles provider-live quantity across DARWIN opening increases and partial reductions", () => {
    const { db, executor } = memoryExecutor();
    insertProviderEvidence(executor);
    db.exec("DELETE FROM provider_position_history; DELETE FROM provider_fills WHERE trade_side = 'close'; DELETE FROM provider_orders WHERE trade_side = 'close';");
    const run = (sql: string, ...values: string[]) => executor.sql(sql.split("?") as unknown as TemplateStringsArray, ...values);
    run("INSERT INTO idempotency (client_order_id, cycle_id, decision_id, provider_order_id, created_at) VALUES (?, ?, ?, ?, ?)", "increase-oid", "cycle-increase", "increase-decision", "provider-increase", "2026-09-21T17:15:00.000Z");
    run("INSERT INTO provider_orders (provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, qty, cum_exec_qty, order_status, created_time, updated_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "provider-increase", "increase-oid", "USDT-FUTURES", "SAMSUNGUSDT", "buy", "long", "open", "2", "2", "filled", "2026-09-21T17:15:00.000Z", "2026-09-21T17:15:00.000Z", "DARWIN", "{}", OPENED_AT, OPENED_AT);
    run("INSERT INTO provider_fills (exec_id, provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, exec_qty, exec_price, created_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "increase-fill", "provider-increase", "increase-oid", "USDT-FUTURES", "SAMSUNGUSDT", "buy", "long", "open", "2", "198.02", "2026-09-21T17:15:00.000Z", "DARWIN", "{}", OPENED_AT, OPENED_AT);
    run("INSERT INTO provider_orders (provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, qty, cum_exec_qty, order_status, created_time, updated_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "provider-reduce", "reduce-oid", "USDT-FUTURES", "SAMSUNGUSDT", "sell", "long", "close", "0.5", "0.5", "filled", "2026-09-21T17:16:00.000Z", "2026-09-21T17:16:00.000Z", "DARWIN", "{}", OPENED_AT, OPENED_AT);
    run("INSERT INTO provider_fills (exec_id, provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, exec_qty, exec_price, created_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "reduce-fill", "provider-reduce", "reduce-oid", "USDT-FUTURES", "SAMSUNGUSDT", "sell", "long", "close", "0.5", "198.02", "2026-09-21T17:16:00.000Z", "DARWIN", "{}", OPENED_AT, OPENED_AT);
    const providerPosition = { symbol: "SAMSUNGUSDT", positionSide: "LONG", quantity: "9.01", entryPrice: "198.02", leverage: "4", marginAllocated: "445", notional: "1785", unrealizedPnl: "12.5", openedAt: OPENED_AT } as never;
    const resolved = resolveProviderTradeFacts(executor, [], "USDT-FUTURES", [providerPosition]);
    expect(resolved.providerOnlyOpenPositions).toEqual([{ position: providerPosition, providerOrderId: "provider-entry-order", decisionId: ENTRY_DECISION_ID }]);
    expect(rebuildProviderPerformance(resolved.lifecycles)).toMatchObject({ openTrades: 1, totalTrades: 1 });
    db.close();
  });

  it("does not attribute provider-live lifecycles containing external or unattributed increase fills to DARWIN", () => {
    for (const origin of ["PROVIDER_EXTERNAL", "UNATTRIBUTED"] as const) {
      const { db, executor } = memoryExecutor();
      insertProviderEvidence(executor);
      db.exec("DELETE FROM provider_position_history; DELETE FROM provider_fills WHERE trade_side = 'close'; DELETE FROM provider_orders WHERE trade_side = 'close';");
      const run = (sql: string, ...values: string[]) => executor.sql(sql.split("?") as unknown as TemplateStringsArray, ...values);
      run("INSERT INTO provider_orders (provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, qty, cum_exec_qty, order_status, created_time, updated_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "external-increase", "manual-increase", "USDT-FUTURES", "SAMSUNGUSDT", "buy", "long", "open", "2", "2", "filled", "2026-09-21T17:15:00.000Z", "2026-09-21T17:15:00.000Z", origin, "{}", OPENED_AT, OPENED_AT);
      run("INSERT INTO provider_fills (exec_id, provider_order_id, client_oid, category, symbol, side, pos_side, trade_side, exec_qty, exec_price, created_time, origin, raw_provider_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "external-increase-fill", "external-increase", "manual-increase", "USDT-FUTURES", "SAMSUNGUSDT", "buy", "long", "open", "2", "198.02", "2026-09-21T17:15:00.000Z", origin, "{}", OPENED_AT, OPENED_AT);
      const providerPosition = { symbol: "SAMSUNGUSDT", positionSide: "LONG", quantity: "9.51", entryPrice: "198.02", leverage: "4", marginAllocated: "470", notional: "1883", unrealizedPnl: "12.5", openedAt: OPENED_AT } as never;
      const resolved = resolveProviderTradeFacts(executor, [], "USDT-FUTURES", [providerPosition]);
      expect(resolved.providerOnlyOpenPositions).toEqual([]);
      expect(rebuildProviderPerformance(resolved.lifecycles)).toMatchObject({ openTrades: 0, totalTrades: 0 });
      db.close();
    }
  });

  it("target-loads persisted experience, context, and journal reasoning for a provider lifecycle outside the initial history limit", async () => {
    const { db, executor } = memoryExecutor();
    insertProviderEvidence(executor);
    saveExperience(executor, openExperience(), "2026-09-01T00:00:00.000Z");
    savePositionContext(executor, positionContext());
    saveJournal(executor, {
      ...journal,
      cycleId: "cycle-target-history",
      startedAt: OPENED_AT,
      decision: { decisionId: ENTRY_DECISION_ID, symbol: "SAMSUNGUSDT", positionSide: "LONG", action: "OPEN_LONG", createdAt: OPENED_AT } as never,
      executionResult: { providerOrderId: "target-journal-order", clientOrderId: "target-client-order" } as never,
    });
    for (let index = 0; index < 25; index += 1) {
      const recent = { ...openExperience(), experienceId: `recent-${index}`, entryDecisionId: `recent-decision-${index}`, symbol: `RECENT${index}USDT`, action: "HOLD" as const, entryTime: "2026-09-20T00:00:00.000Z" };
      saveExperience(executor, recent, `2026-09-22T00:${String(index).padStart(2, "0")}:00.000Z`);
    }
    const agent = fakeAgent(executor, db, true);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: CLOSED_AT } as never);
    const response = await agent.getTradeHistory.call(agent, new URL("https://example.test/trade-history?limit=1"));
    const body = await response.json() as { trades: Array<Record<string, unknown>> };
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0]).toMatchObject({
      tradeId: EXPERIENCE_ID,
      status: "CLOSED",
      reasoningSource: "DARWIN_PERSISTED",
      entryReasoning: expect.objectContaining({ thesis: "preserve this thesis" }),
      orderReference: "target-journal-order",
    });
    db.close();
  });

  it("target-loads local reasoning for a provider-live lifecycle outside the initial history limit", async () => {
    const { db, executor } = memoryExecutor();
    insertProviderEvidence(executor);
    db.exec("DELETE FROM provider_position_history; DELETE FROM provider_fills WHERE trade_side = 'close'; DELETE FROM provider_orders WHERE trade_side = 'close';");
    saveExperience(executor, openExperience(), "2026-09-01T00:00:00.000Z");
    savePositionContext(executor, positionContext());
    saveJournal(executor, {
      ...journal,
      cycleId: "cycle-live-target-history",
      startedAt: OPENED_AT,
      decision: { decisionId: ENTRY_DECISION_ID, symbol: "SAMSUNGUSDT", positionSide: "LONG", action: "OPEN_LONG", createdAt: OPENED_AT } as never,
      executionResult: { providerOrderId: "target-live-journal-order", clientOrderId: "target-live-client-order" } as never,
    });
    for (let index = 0; index < 25; index += 1) {
      const recent = { ...openExperience(), experienceId: `live-recent-${index}`, entryDecisionId: `live-recent-decision-${index}`, symbol: `LIVE${index}USDT`, action: "HOLD" as const };
      saveExperience(executor, recent, `2026-09-22T01:${String(index).padStart(2, "0")}:00.000Z`);
    }
    const agent = fakeAgent(executor, db, true);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({
      positions: [{ symbol: "SAMSUNGUSDT", positionSide: "LONG", quantity: "7.51", entryPrice: "198.02", leverage: "4", marginAllocated: "370", notional: "1490.13", unrealizedPnl: "12.5", openedAt: OPENED_AT }],
      portfolioEquity: "1000", observedAt: CLOSED_AT,
    } as never);
    const response = await agent.getTradeHistory.call(agent, new URL("https://example.test/trade-history?limit=1"));
    const body = await response.json() as { trades: Array<Record<string, unknown>> };
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0]).toMatchObject({
      tradeId: EXPERIENCE_ID,
      status: "OPEN",
      financialSource: "PROVIDER_LIVE",
      reasoningSource: "DARWIN_PERSISTED",
      entryReasoning: expect.objectContaining({ thesis: "preserve this thesis" }),
      orderReference: "target-live-journal-order",
    });
    db.close();
  });

  it("does not claim authoritative OPEN when provider financial facts cannot be resolved", async () => {
    const { db, executor } = memoryExecutor();
    saveExperience(executor, openExperience(), OPENED_AT);
    const agent = fakeAgent(executor, db, true);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: CLOSED_AT } as never);
    const response = await agent.getTradeHistory.call(agent, new URL("https://example.test/trade-history?limit=25"));
    const body = await response.json() as { trades: Array<Record<string, unknown>> };
    expect(body.trades).toContainEqual(expect.objectContaining({ tradeId: EXPERIENCE_ID, status: "UNRESOLVED", localLifecycleStatus: "PARTIALLY_REDUCED", financialSource: "UNRESOLVED", quantity: "UNAVAILABLE", entry: "UNAVAILABLE", openedAt: "UNAVAILABLE", entryTime: "UNAVAILABLE", legacyEntryTime: LOCAL_ENTRY_AT, legacyEntryPrice: "198.02", realizedPnl: "UNAVAILABLE" }));
    db.close();
  });

  it("requires owner authentication on the control action", async () => {
    const { db, executor } = memoryExecutor();
    const agent = fakeAgent(executor, db, true);
    const providerRead = vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio");
    const response = await invokeControl(agent, false);
    expect(response.status).toBe(401);
    expect(providerRead).not.toHaveBeenCalled();
    expect(loadAllEvents(executor)).toHaveLength(0);
    db.close();
  });

  it("rejects repair while ONLINE before any provider read or persistence", async () => {
    const { db, executor } = memoryExecutor();
    saveExperience(executor, openExperience(), OPENED_AT);
    savePositionContext(executor, positionContext());
    const providerRead = vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio");
    await expect(invokeRepair(fakeAgent(executor, db, false))).rejects.toThrow("AGENT_MUST_BE_PAUSED");
    expect(providerRead).not.toHaveBeenCalled();
    expect(loadAllExperiences(executor)[0]?.outcomeStatus).toBe("OPEN");
    expect(loadAllEvents(executor)).toHaveLength(0);
    db.close();
  });

  it("rechecks PAUSED state after the awaited provider read", async () => {
    const { db, executor } = memoryExecutor();
    saveExperience(executor, openExperience(), OPENED_AT);
    savePositionContext(executor, positionContext());
    insertProviderEvidence(executor);
    const agent = fakeAgent(executor, db, true);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockImplementation(async () => {
      agent.state.paused = false;
      agent.state.runtimeStatus = "ONLINE";
      return { positions: [], portfolioEquity: "1000", observedAt: CLOSED_AT } as never;
    });
    await expect(invokeRepair(agent)).rejects.toThrow("AGENT_MUST_BE_PAUSED");
    expect(loadAllExperiences(executor)[0]?.outcomeStatus).toBe("OPEN");
    expect(loadAllEvents(executor)).toHaveLength(0);
    db.close();
  });

  it("reuses the persisted external-flow read model and invalidates it after a provider sync revision", async () => {
    const { db, executor, queries } = memoryExecutor();
    insertProviderEvidence(executor);
    const agent = fakeAgent(executor, db, true);
    const observedAt = new Date().toISOString();
    const coveredFrom = new Date(Date.now() - 60_000).toISOString();
    for (const category of PROVIDER_FINANCIAL_CATEGORIES) {
      saveProviderSyncState(executor, {
        category,
        checkpoints: {},
        lastSuccessfulSyncAt: observedAt,
        lastReconciliationAt: null,
        lastError: null,
        updatedAt: observedAt,
        financialRecordCoverage: { coveredFrom, coveredThrough: observedAt, lastSuccessfulSyncAt: observedAt, lastError: null },
      });
    }
    const insertFinancial = (key: string, type: string, amount: string) => executor.sql`
      INSERT INTO provider_financial_records (provider_record_key, provider_record_id, category, symbol, type, coin, amount, fee, provider_timestamp, origin, raw_provider_json, first_seen_at, last_seen_at)
      VALUES (${key}, ${key}, 'USDT-FUTURES', 'BTCUSDT', ${type}, 'USDT', ${amount}, '0', ${observedAt}, 'UNATTRIBUTED', '{}', ${observedAt}, ${observedAt})
    `;
    insertFinancial("snapshot-flow-in", "TRANSFER_IN", "5");
    agent.persistPerformanceEquity.call(agent, "1000", observedAt);
    const portfolio = { positions: [], portfolioEquity: "1000", observedAt } as never;
    const recordReadCount = () => queries.filter((query) => query.includes("FROM provider_financial_records")).length;
    const historyReadCount = () => queries.filter((query) => query.includes("FROM provider_position_history")).length;
    const beforeFirst = recordReadCount();
    const beforeFirstHistory = historyReadCount();
    const first = await agent.getDashboardSnapshot.call(agent, portfolio);
    expect(first.performance.closedTrades).toBe(1);
    expect(first.accountPerformance).toMatchObject({ externalFlowStatus: "VERIFIED", netExternalInflows: "5" });
    expect(recordReadCount() - beforeFirst).toBe(1);
    expect(historyReadCount() - beforeFirstHistory).toBeGreaterThan(0);

    const beforeRepeat = recordReadCount();
    const beforeRepeatHistory = historyReadCount();
    const nextAgentInstance = fakeAgent(executor, db, true);
    const repeated = await nextAgentInstance.getDashboardSnapshot.call(nextAgentInstance, portfolio);
    expect(repeated.performance.closedTrades).toBe(1);
    expect(repeated.accountPerformance).toMatchObject({ externalFlowStatus: "VERIFIED", netExternalInflows: "5" });
    expect(recordReadCount() - beforeRepeat).toBe(0);
    expect(historyReadCount() - beforeRepeatHistory).toBe(0);

    saveProviderSyncState(executor, loadProviderSyncState(executor, "USDT-FUTURES")!);
    insertFinancial("snapshot-flow-out", "TRANSFER_OUT", "-2");
    const beforeInvalidation = recordReadCount();
    const beforeInvalidatedHistory = historyReadCount();
    const invalidated = await agent.getDashboardSnapshot.call(agent, portfolio);
    expect(invalidated.accountPerformance).toMatchObject({ externalFlowStatus: "VERIFIED", netExternalInflows: "3" });
    expect(recordReadCount() - beforeInvalidation).toBe(1);
    expect(historyReadCount() - beforeInvalidatedHistory).toBeGreaterThan(0);
    db.close();
  });

  it("repairs from real SQLite provider evidence, preserves the journal, writes one audit, and is a write-free retry", async () => {
    const { db, executor } = memoryExecutor();
    const original = openExperience();
    const oldContext = positionContext();
    saveExperience(executor, original, OPENED_AT);
    savePositionContext(executor, oldContext);
    saveJournal(executor, journal);
    insertProviderEvidence(executor);
    const journalBytesBefore = db.prepare("SELECT payload FROM journals WHERE cycle_id = ?").get("cycle-entry") as { payload: string };
    const providerRead = vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: CLOSED_AT } as never);
    const agent = fakeAgent(executor, db, true);

    const response = await invokeControl(agent);
    const firstBody = await response.json() as { reconciliation: { status: string } };
    const first = firstBody.reconciliation;
    const repaired = loadAllExperiences(executor)[0]!;
    const context = loadPositionContext(executor, "SAMSUNGUSDT", "LONG")!;
    const event = loadAllEvents(executor).filter((item) => item.type === "PROVIDER_LIFECYCLE_REPAIRED");
    const journalBytesAfter = db.prepare("SELECT payload FROM journals WHERE cycle_id = ?").get("cycle-entry") as { payload: string };
    expect(response.status).toBe(200);
    expect(first.status).toBe("RECONCILED");
    expect(repaired).toMatchObject({ experienceId: EXPERIENCE_ID, entryDecisionId: ENTRY_DECISION_ID, outcomeStatus: "PROFITABLE", financialSource: "PROVIDER_LEDGER", origin: "DARWIN", providerPositionHistoryId: HISTORY_ID, entryPrice: "198.02", exitPrice: "202.66", entryTime: OPENED_AT, exitTime: CLOSED_AT, closedQuantity: "7.51", cumRealisedPnl: "34.8487", netProfit: "33.19485709", realizedPnl: "33.19485709", openFeeTotal: "-0.89227812", closeFeeTotal: "-0.91318734", totalFunding: "0.15162255", cashDividend: "0", legacyLocalRealizedPnl: "19.1364", entryThesis: original.entryThesis, evidenceAtEntry: original.evidenceAtEntry, lessonsUsed: original.lessonsUsed });
    expect(context).toMatchObject({ lifecycleStatus: "CLOSED", closedAt: CLOSED_AT, closedProviderPositionHistoryId: HISTORY_ID, entryDecisionId: ENTRY_DECISION_ID, entryReasoning: oldContext.entryReasoning, managementEvents: oldContext.managementEvents });
    expect(journalBytesAfter.payload).toBe(journalBytesBefore.payload);
    const repairedExperience = loadAllExperiences(executor).find((experience) => experience.experienceId === EXPERIENCE_ID)!;
    const lifecycleClassification = classifyProviderLifecycle(loadProviderLifecycleEvidence(executor, repairedExperience, "USDT-FUTURES", HISTORY_ID, []));
    expect(lifecycleClassification.classification).toBe("MATCHED_CLOSED");
    const lifecycleReadModel = resolveProviderTradeFacts(executor, [repairedExperience], "USDT-FUTURES", [{ symbol: "SAMSUNGUSDT", positionSide: "LONG", quantity: "0.5", notional: "99", marginAllocated: "10", leverage: "2", entryPrice: "198", unrealizedPnl: "0", realizedPnl: "0" }]);
    expect(lifecycleReadModel.facts.get(EXPERIENCE_ID)).toMatchObject({ source: "PROVIDER_LEDGER", origin: "DARWIN", providerPositionHistoryId: HISTORY_ID });
    expect(event).toHaveLength(1);
    expect(event[0]?.metadata).toMatchObject({ origin: "DARWIN", providerPositionHistoryOrigin: "UNATTRIBUTED", providerPositionHistoryId: HISTORY_ID, closedQuantity: "7.51", netProfit: "33.19485709", legacyLocalRealizedPnl: "19.1364" });
    expect(providerRead).toHaveBeenCalledTimes(1);
    expect(executePaperOrder).not.toHaveBeenCalled();

    const historyResponse = await agent.onRequest.call(agent, new Request("https://example.test/trade-history?limit=25"));
    const historyBody = await historyResponse.json() as { trades: Array<Record<string, unknown>> };
    const samsung = historyBody.trades.find((trade) => trade.tradeId === EXPERIENCE_ID);
    expect(samsung).toMatchObject({ symbol: "SAMSUNGUSDT", positionSide: "LONG", status: "CLOSED", entry: "198.02", exit: "202.66", entryTime: OPENED_AT, exitTime: CLOSED_AT, realizedPnl: "33.19485709", quantity: "7.51", cumRealisedPnl: "34.8487", netProfit: "33.19485709", openFeeTotal: "-0.89227812", closeFeeTotal: "-0.91318734", totalFunding: "0.15162255", cashDividend: "0", financialSource: "PROVIDER_LEDGER", reasoningSource: "DARWIN_PERSISTED", origin: "DARWIN", providerPositionHistoryId: HISTORY_ID });
    expect(samsung?.realizedPnl).not.toBe("19.1364");

    const originalSql = agent.sql;
    let performanceCacheWrites = 0;
    let injectedFailure = false;
    agent.sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("INSERT INTO risk_state")) {
        performanceCacheWrites += 1;
        if (performanceCacheWrites === 2 && !injectedFailure) {
          injectedFailure = true;
          throw new Error("performance-rebuild-fault");
        }
      }
      return originalSql(strings, ...values as (string | number | boolean | null)[]);
    }) as typeof agent.sql;
    await expect(agent.getDashboardSnapshot.call(agent, { positions: [], portfolioEquity: "1000", observedAt: CLOSED_AT } as never)).rejects.toThrow("performance-rebuild-fault");
    expect(injectedFailure).toBe(true);

    const snapshot = await agent.getDashboardSnapshot.call(agent, { positions: [], portfolioEquity: "1000", observedAt: CLOSED_AT } as never);
    expect(snapshot.performance).toMatchObject({ financialSource: "PROVIDER_LEDGER", scope: "DARWIN_ATTRIBUTED", totalTrades: 1, openTrades: 0, closedTrades: 1, wins: 1, losses: 0, breakeven: 0, totalPnl: "33.19485709", closedEpisodeRealizedPnl: "33.19485709", verifiedRealizedPnl: "33.19485709" });
    expect(snapshot.accountPerformance).toMatchObject({ equitySource: "PROVIDER_LIVE", externalFlowStatus: "UNVERIFIED", netExternalInflows: "UNAVAILABLE", netPnlSinceBaseline: "UNAVAILABLE" });
    const repeatedSnapshot = await agent.getDashboardSnapshot.call(agent, { positions: [], portfolioEquity: "1000", observedAt: CLOSED_AT } as never);
    expect(repeatedSnapshot.performance.closedTrades).toBe(1);
    expect(repeatedSnapshot.performance.totalPnl).toBe("33.19485709");
    const liveSnapshotResponse = await agent.onRequest.call(agent, new Request("https://example.test/snapshot"));
    const liveSnapshot = await liveSnapshotResponse.json() as { portfolioFreshness: { source: string }; accountPerformance: { equitySource: string } };
    expect(liveSnapshot.portfolioFreshness.source).toBe("PROVIDER_LIVE");
    expect(liveSnapshot.accountPerformance.equitySource).toBe("PROVIDER_LIVE");
    expect(providerRead).toHaveBeenCalledTimes(3);

    const writesBeforeRetry = db.prepare("SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM experiences) + (SELECT COUNT(*) FROM position_context) AS count").get() as { count: number };
    providerRead.mockClear();
    const secondResponse = await invokeControl(agent);
    const secondBody = await secondResponse.json() as { reconciliation: { status: string } };
    const second = secondBody.reconciliation;
    const writesAfterRetry = db.prepare("SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM experiences) + (SELECT COUNT(*) FROM position_context) AS count").get() as { count: number };
    expect(second.status).toBe("ALREADY_RECONCILED");
    expect(providerRead).not.toHaveBeenCalled();
    expect(writesAfterRetry.count).toBe(writesBeforeRetry.count);
    expect(loadAllEvents(executor).filter((item) => item.type === "PROVIDER_LIFECYCLE_REPAIRED")).toHaveLength(1);
    expect(hasEvent(executor, `provider-lifecycle-repair:${EXPERIENCE_ID}:${HISTORY_ID}`)).toBe(true);
    db.close();
  });

  it("rejects inconsistent already-reconciled derived state without provider reads or writes", async () => {
    const variants = [
      { name: "missing audit event", context: positionContext(), auditEvent: false },
      { name: "missing context", context: null },
      { name: "wrong experienceId", context: { ...positionContext(), experienceId: "other-experience" } },
      { name: "wrong entryDecisionId", context: { ...positionContext(), entryDecisionId: "other-decision" } },
      { name: "open context", context: { ...positionContext(), lifecycleStatus: "OPEN" as const } },
      { name: "wrong closed history ID", context: { ...positionContext(), lifecycleStatus: "CLOSED" as const, closedProviderPositionHistoryId: "other-history" } },
    ];
    for (const variant of variants) {
      const { db, executor } = memoryExecutor();
      const repaired = { ...openExperience(), outcomeStatus: "PROFITABLE" as const, financialSource: "PROVIDER_LEDGER" as const, providerPositionHistoryId: HISTORY_ID };
      saveExperience(executor, repaired, CLOSED_AT);
      if (variant.context) savePositionContext(executor, variant.context);
      if (variant.auditEvent !== false) saveEvent(executor, { eventId: `provider-lifecycle-repair:${EXPERIENCE_ID}:${HISTORY_ID}`, type: "PROVIDER_LIFECYCLE_REPAIRED", cycleId: "cycle-entry", createdAt: CLOSED_AT, metadata: { experienceId: EXPERIENCE_ID, entryDecisionId: ENTRY_DECISION_ID, providerPositionHistoryId: HISTORY_ID } });
      const providerRead = vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: CLOSED_AT } as never);
      const agent = fakeAgent(executor, db, true);
      const before = db.prepare("SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM experiences) + (SELECT COUNT(*) FROM position_context) AS count").get() as { count: number };
      await expect(invokeRepair(agent)).rejects.toThrow("PROVIDER_LIFECYCLE_REPAIR_STATE_INCONSISTENT");
      const after = db.prepare("SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM experiences) + (SELECT COUNT(*) FROM position_context) AS count").get() as { count: number };
      expect(after.count, variant.name).toBe(before.count);
      expect(providerRead, variant.name).not.toHaveBeenCalled();
      providerRead.mockRestore();
      db.close();
    }
  });

  it("rejects contradictory current provider positions without changing financial state", async () => {
    const { db, executor } = memoryExecutor();
    saveExperience(executor, openExperience(), OPENED_AT);
    savePositionContext(executor, positionContext());
    insertProviderEvidence(executor);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [{ symbol: "SAMSUNGUSDT", positionSide: "LONG", quantity: "0.01" }], portfolioEquity: "1000", observedAt: CLOSED_AT } as never);
    await expect(invokeRepair(fakeAgent(executor, db, true))).rejects.toThrow("PROVIDER_LIFECYCLE_CONTRADICTORY");
    expect(loadAllExperiences(executor)[0]?.realizedPnl).toBe("19.1364");
    expect(loadAllExperiences(executor)[0]?.outcomeStatus).toBe("OPEN");
    expect(loadAllEvents(executor)).toHaveLength(0);
    db.close();
  });

  it("rolls back every persistence-boundary fault atomically", () => {
    for (const failAfterWrite of [1, 2, 3]) {
      const { db, executor } = memoryExecutor();
      const original = openExperience();
      const context = positionContext();
      saveExperience(executor, original, OPENED_AT);
      savePositionContext(executor, context);
      let writes = 0;
      const failingExecutor: SqlExecutor = {
        sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
          const result = executor.sql<T>(strings, ...values);
          const query = strings.join("").trimStart().toUpperCase();
          if (!query.startsWith("SELECT")) {
            writes += 1;
            if (writes === failAfterWrite) throw new Error(`fault-${failAfterWrite}`);
          }
          return result;
        },
      };
      const closed = { ...original, outcomeStatus: "PROFITABLE" as const, realizedPnl: "33.19485709", financialSource: "PROVIDER_LEDGER" as const, providerPositionHistoryId: HISTORY_ID };
      const closedContext = { ...context, lifecycleStatus: "CLOSED" as const, closedProviderPositionHistoryId: HISTORY_ID };
      const audit = { eventId: `fault-event-${failAfterWrite}`, type: "PROVIDER_LIFECYCLE_REPAIRED", cycleId: "cycle-entry", createdAt: CLOSED_AT };
      expect(() => persistProviderLifecycleRepair(failingExecutor, (closure) => transaction(db, closure), original, context, closed, closedContext, audit)).toThrow(`fault-${failAfterWrite}`);
      expect(loadAllExperiences(executor)[0]).toEqual(original);
      expect(loadPositionContext(executor, "SAMSUNGUSDT", "LONG")).toEqual(context);
      expect(loadAllEvents(executor)).toHaveLength(0);
      db.close();
    }
  });

  it("rejects a stale competing repair for a different history ID", () => {
    const { db, executor } = memoryExecutor();
    const original = openExperience();
    const originalContext = positionContext();
    saveExperience(executor, original, OPENED_AT);
    savePositionContext(executor, originalContext);
    const firstExperience = { ...original, outcomeStatus: "PROFITABLE" as const, realizedPnl: "33.19485709", financialSource: "PROVIDER_LEDGER" as const, origin: "DARWIN" as const, providerPositionHistoryId: HISTORY_ID };
    const firstContext = { ...originalContext, lifecycleStatus: "CLOSED" as const, closedProviderPositionHistoryId: HISTORY_ID };
    const firstEvent = { eventId: `provider-lifecycle-repair:${EXPERIENCE_ID}:${HISTORY_ID}`, type: "PROVIDER_LIFECYCLE_REPAIRED", cycleId: "cycle-entry", createdAt: CLOSED_AT };
    expect(persistProviderLifecycleRepair(executor, (closure) => transaction(db, closure), original, originalContext, firstExperience, firstContext, firstEvent)).toBe(true);

    const competingId = "1485976014620573699";
    const competingExperience = { ...original, outcomeStatus: "LOSING" as const, realizedPnl: "-1", financialSource: "PROVIDER_LEDGER" as const, origin: "DARWIN" as const, providerPositionHistoryId: competingId };
    const competingContext = { ...originalContext, lifecycleStatus: "CLOSED" as const, closedProviderPositionHistoryId: competingId };
    const competingEvent = { eventId: `provider-lifecycle-repair:${EXPERIENCE_ID}:${competingId}`, type: "PROVIDER_LIFECYCLE_REPAIRED", cycleId: "cycle-entry", createdAt: CLOSED_AT };
    expect(() => persistProviderLifecycleRepair(executor, (closure) => transaction(db, closure), original, originalContext, competingExperience, competingContext, competingEvent)).toThrow("PROVIDER_LIFECYCLE_REPAIR_CONFLICT");
    expect(loadAllExperiences(executor)[0]).toEqual(firstExperience);
    expect(loadPositionContext(executor, "SAMSUNGUSDT", "LONG")).toEqual(firstContext);
    expect(loadAllEvents(executor)).toHaveLength(1);
    db.close();
  });

  it("treats an existing atomic repair marker as a true no-op", () => {
    const { db, executor } = memoryExecutor();
    const original = openExperience();
    const originalContext = positionContext();
    saveExperience(executor, original, OPENED_AT);
    savePositionContext(executor, originalContext);
    const exp = { ...original, outcomeStatus: "PROFITABLE" as const, realizedPnl: "33.19485709", financialSource: "PROVIDER_LEDGER" as const, origin: "DARWIN" as const, providerPositionHistoryId: HISTORY_ID };
    const ctx = { ...originalContext, lifecycleStatus: "CLOSED" as const, closedProviderPositionHistoryId: HISTORY_ID };
    const event = { eventId: "repair-no-op", type: "PROVIDER_LIFECYCLE_REPAIRED", cycleId: "cycle-entry", createdAt: CLOSED_AT };
    expect(persistProviderLifecycleRepair(executor, (closure) => transaction(db, closure), original, originalContext, exp, ctx, event)).toBe(true);
    const before = db.prepare("SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM experiences) + (SELECT COUNT(*) FROM position_context) AS count").get() as { count: number };
    expect(persistProviderLifecycleRepair(executor, (closure) => transaction(db, closure), original, originalContext, exp, ctx, event)).toBe(false);
    const after = db.prepare("SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM experiences) + (SELECT COUNT(*) FROM position_context) AS count").get() as { count: number };
    expect(after.count).toBe(before.count);
    expect(loadAllEvents(executor)).toHaveLength(1);
    db.close();
  });
});
