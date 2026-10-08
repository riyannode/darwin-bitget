import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
vi.mock("agents", () => ({ Agent: class {}, routeAgentRequest: vi.fn() }));
import server from "../src/server.js";
import { BitgetClient } from "../src/bitget/client.js";
import { TraderAgent } from "../src/agent/agent.js";
import { clampHistoryLimit, loadExecutionQuarantines, saveExecutionQuarantine, saveJournal } from "../src/storage/store.js";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { PROVIDER_FINANCIAL_CATEGORIES } from "../src/bitget/provider-sync.js";
import type { AccountSnapshot, Env, OwnerPolicy, TradingJournal } from "../src/types.js";

const policy: OwnerPolicy = {
  paperOnly: true,
  maxSinglePositionMarginPct: "30",
  maxLeverage: "5",
  maxDailyDrawdownPct: "10",
  drawdownCooldownMinutes: 60,
  scanIntervalMinutes: 15,
  emergencyStop: false,
};

const portfolio: AccountSnapshot = {
  balance: "1000",
  availableBalance: "900",
  availableMargin: "900",
  marginUsage: "100",
  positionNotional: "300",
  totalPositionNotional: "300",
  positionQuantity: "3",
  portfolioEquity: "1000",
  positions: [{ symbol: "CRCLUSDT", positionSide: "LONG", quantity: "3", notional: "300", marginAllocated: "100", leverage: "3", entryPrice: "100", markPrice: "101", unrealizedPnl: "3", unrealizedPnlPct: "1", realizedPnl: "0" }],
  realizedPnl: "0",
  unrealizedPnl: "3",
  openOrders: 0,
  openOrderSymbols: [],
  observedAt: "2026-09-13T00:00:00.000Z",
};

function envWithThrowingDo(): Env {
  const namespace = {
    idFromName: vi.fn(() => { throw new Error("DO_MUST_NOT_BE_TOUCHED"); }),
    get: vi.fn(),
  };
  return {
    TRADER_AGENT: namespace,
    TRADING_MODE: "PAPER",
    AGENT_MODE: "AUTONOMOUS",
    PAPER_ONLY: "true",
    BITGET_CATEGORY: "USDT-FUTURES",
    EVIDENCE_MAX_AGE_SECONDS: "90",
    BITGET_API_BASE_URL: "https://api.bitget.com",
    MAX_SINGLE_POSITION_MARGIN_PCT: "30",
    MAX_LEVERAGE: "5",
    MAX_DAILY_DRAWDOWN_PCT: "10",
    DRAWDOWN_COOLDOWN_MINUTES: "60",
    SCAN_INTERVAL_MINUTES: "15",
  } as unknown as Env;
}

afterEach(() => vi.restoreAllMocks());

describe("provider live read path", () => {
  it("returns provider portfolio without touching the Durable Object", async () => {
    const read = vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue(portfolio);
    const place = vi.spyOn(BitgetClient.prototype, "placePaperOrder");
    const response = await server.fetch(new Request("https://darwin.test/api/live/portfolio"), envWithThrowingDo());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ source: "PROVIDER_LIVE", portfolio });
    expect(read).toHaveBeenCalledOnce();
    expect(place).not.toHaveBeenCalled();
  });
});

describe("bounded Durable Object read paths", () => {
  it("loads snapshot policy once and reuses its config for the provider and snapshot", async () => {
    const ensureActivePolicy = vi.fn(() => policy);
    const getDashboardSnapshot = vi.fn(async () => ({ ok: true }));
    const fake = {
      env: envWithThrowingDo(),
      ensureActivePolicy,
      getDashboardSnapshot,
    };
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue(portfolio);

    const response = await TraderAgent.prototype.onRequest.call(fake as never, new Request("https://darwin.test/snapshot"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(ensureActivePolicy).toHaveBeenCalledOnce();
    expect(getDashboardSnapshot).toHaveBeenCalledWith(portfolio, expect.objectContaining({ ownerPolicy: policy }));
  });

  it("routes owner lifecycle-performance maintenance to the Durable Object only", async () => {
    let forwardedPath = "";
    const namespace = {
      idFromName: () => "primary",
      get: () => ({ fetch: async (request: Request) => { forwardedPath = new URL(request.url).pathname; return Response.json({ ok: true }); } }),
    };
    const env = { ...envWithThrowingDo(), TRADER_AGENT: namespace } as unknown as Env;
    const response = await server.fetch(new Request("https://darwin.test/api/provider-performance/rebuild", { method: "POST" }), env);

    expect(response.status).toBe(200);
    expect(forwardedPath).toBe("/provider-performance/rebuild");
  });

  it("routes owner execution-quarantine diagnostics to the Durable Object and preserves its authorization", async () => {
    let forwardedPath = "";
    let forwardedAuthorization = "";
    const namespace = {
      idFromName: () => "primary",
      get: () => ({ fetch: async (request: Request) => {
        forwardedPath = new URL(request.url).pathname;
        forwardedAuthorization = request.headers.get("authorization") ?? "";
        return Response.json({ ok: true });
      } }),
    };
    const env = { ...envWithThrowingDo(), TRADER_AGENT: namespace } as unknown as Env;
    const response = await server.fetch(new Request("https://darwin.test/api/execution-quarantines?symbols=CRCLUSDT,MSTRUSDT", {
      headers: { authorization: "Bearer owner-token" },
    }), env);

    expect(response.status).toBe(200);
    expect(forwardedPath).toBe("/execution-quarantines");
    expect(forwardedAuthorization).toBe("Bearer owner-token");
  });

  it("rejects unauthenticated quarantine diagnostics before reading persisted state", async () => {
    const fake = { env: { OWNER_CONTROL_TOKEN: "configured" }, sql: () => { throw new Error("storage must not be read"); } };
    const request = new Request("https://darwin.test/execution-quarantines?symbols=CRCLUSDT");
    const response = await (TraderAgent.prototype as unknown as { executionQuarantineDiagnostics: (request: Request, url: URL) => Promise<Response> }).executionQuarantineDiagnostics.call(fake, request, new URL(request.url));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "OWNER_AUTH_REQUIRED" });
  });

  it("rejects oversized raw symbol input before touching persisted state", async () => {
    const fake = { env: { OWNER_CONTROL_TOKEN: "configured" }, sql: () => { throw new Error("storage must not be read"); } };
    const request = new Request(`https://darwin.test/execution-quarantines?symbols=${"A".repeat(257)}`, { headers: { authorization: "Bearer configured" } });
    const response = await (TraderAgent.prototype as unknown as { executionQuarantineDiagnostics: (request: Request, url: URL) => Promise<Response> }).executionQuarantineDiagnostics.call(fake, request, new URL(request.url));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_SYMBOLS" });
  });

  it("rejects too many symbols before storage or provider access", async () => {
    const fake = { env: { OWNER_CONTROL_TOKEN: "configured" }, sql: () => { throw new Error("storage must not be read"); } };
    const getDashboardPortfolio = vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio");
    const symbols = Array.from({ length: 9 }, () => "CRCLUSDT").join(",");
    const request = new Request(`https://darwin.test/execution-quarantines?symbols=${symbols}`, { headers: { authorization: "Bearer configured" } });
    const response = await (TraderAgent.prototype as unknown as { executionQuarantineDiagnostics: (request: Request, url: URL) => Promise<Response> }).executionQuarantineDiagnostics.call(fake, request, new URL(request.url));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_SYMBOLS" });
    expect(getDashboardPortfolio).not.toHaveBeenCalled();
  });

  it("returns owner diagnostics from persisted quarantine state with direct provider matches and no quarantine writes", async () => {
    const db = new DatabaseSync(":memory:");
    const executor: SqlExecutor = {
      sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
        const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
        return db.prepare(query).all(...values.map((value) => typeof value === "boolean" ? Number(value) : value)) as T[];
      },
    };
    ensureStorage(executor);
    const active = { symbol: "CRCLUSDT", decisionId: "decision-crcl", cycleId: "cycle-crcl", clientOrderId: "client-crcl", reason: "POSITION_READBACK_UNAVAILABLE", createdAt: "2026-10-07T00:00:00.000Z" };
    const journal = {
      cycleId: active.cycleId,
      mode: "AUTONOMOUS",
      startedAt: active.createdAt,
      completedAt: "2026-10-07T00:01:00.000Z",
      executionRecords: [{
        decision: { decisionId: active.decisionId, cycleId: active.cycleId, symbol: active.symbol, action: "OPEN_LONG", positionSide: "LONG" },
        executionResult: { status: "filled", providerOrderId: "provider-crcl", clientOrderId: active.clientOrderId, providerSide: "buy", tradeSide: "open", executedQuantity: "3", averageFillPrice: "100", submittedAt: active.createdAt, readBackAt: "2026-10-07T00:00:10.000Z" },
        reconciliationResult: { status: "MISMATCH", codes: ["POSITION_READBACK_UNAVAILABLE"], execution: { status: "filled" } },
      }],
    } as unknown as TradingJournal;
    saveExecutionQuarantine(executor, active);
    saveJournal(executor, journal);
    const env = {
      OWNER_CONTROL_TOKEN: "owner-token", TRADING_MODE: "PAPER", AGENT_MODE: "AUTONOMOUS", PAPER_ONLY: "true",
      BITGET_CATEGORY: "USDT-FUTURES", EVIDENCE_MAX_AGE_SECONDS: "90", BITGET_API_BASE_URL: "https://api.bitget.com",
      MAX_SINGLE_POSITION_MARGIN_PCT: "30", MAX_LEVERAGE: "5", MAX_DAILY_DRAWDOWN_PCT: "10", DRAWDOWN_COOLDOWN_MINUTES: "60", SCAN_INTERVAL_MINUTES: "15",
    };
    const fake = { env, sql: executor.sql };
    const before = JSON.stringify(loadExecutionQuarantines(executor));
    const placePaperOrder = vi.spyOn(BitgetClient.prototype, "placePaperOrder");
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue(portfolio);
    vi.spyOn(BitgetClient.prototype, "getOrderDetailsRead").mockResolvedValue({ orderId: "provider-crcl", clientOid: "client-crcl", symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open", qty: "3", cumExecQty: "3", avgPrice: "100", orderStatus: "filled", createdTime: "1789968749335" });
    const getFillHistoryRead = vi.spyOn(BitgetClient.prototype, "getFillHistoryRead").mockResolvedValue({ list: [
      { execId: "fill-a", orderId: "provider-crcl", clientOid: "client-crcl", symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open", execQty: "1", execPrice: "100", createdTime: "1789968749337" },
      { execId: "fill-b", orderId: "provider-crcl", clientOid: "client-crcl", symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open", execQty: "2", execPrice: "100", createdTime: "1789968749338" },
    ] });
    const request = new Request("https://darwin.test/execution-quarantines?symbols=CRCLUSDT", { headers: { authorization: "Bearer owner-token" } });
    const response = await (TraderAgent.prototype as unknown as { executionQuarantineDiagnostics: (request: Request, url: URL) => Promise<Response> }).executionQuarantineDiagnostics.call(fake, request, new URL(request.url));
    const body = await response.json() as { diagnostics: Array<{ identity: { clientOrderId: string }; providerPositionReadback: { position: { quantity: string } | null }; providerReadback: { status: string; matches: { aggregateFillQuantity: string | null; aggregateFillQuantityMatchesExecution: boolean | null; invalidMatchingProviderFillRows: number; order: { providerOrderId: boolean | null } }; fills: Array<{ matchesQuarantineIdentity: boolean }> } }> };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.diagnostics[0]).toMatchObject({
      identity: { clientOrderId: "client-crcl" },
      providerPositionReadback: { status: "SUCCESS", position: { quantity: "3" } },
      providerReadback: { status: "ORDER_AND_FILLS_FOUND", matches: { aggregateFillQuantity: "3", aggregateFillQuantityMatchesExecution: true } },
    });
    expect(body.diagnostics[0]?.providerReadback.fills).toHaveLength(2);
    getFillHistoryRead.mockResolvedValue({ list: [
      { execId: "foreign-fill", orderId: "provider-crcl", clientOid: "other-client", symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open", execQty: "3", execPrice: "100", createdTime: "1789968749339" },
    ] });
    const mismatchedResponse = await (TraderAgent.prototype as unknown as { executionQuarantineDiagnostics: (request: Request, url: URL) => Promise<Response> }).executionQuarantineDiagnostics.call(fake, request, new URL(request.url));
    const mismatchedBody = await mismatchedResponse.json() as typeof body;
    expect(mismatchedBody.diagnostics[0]?.providerReadback.fills[0]?.matchesQuarantineIdentity).toBe(false);
    expect(mismatchedBody.diagnostics[0]?.providerReadback.matches.aggregateFillQuantity).toBeNull();
    expect(mismatchedBody.diagnostics[0]?.providerReadback.matches.aggregateFillQuantityMatchesExecution).toBe(false);
    const exactFills = [
      { execId: "fill-a", orderId: "provider-crcl", clientOid: "client-crcl", symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open", execQty: "1", execPrice: "100", createdTime: "1789968749337" },
      { execId: "fill-b", orderId: "provider-crcl", clientOid: "client-crcl", symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open", execQty: "2", execPrice: "100", createdTime: "1789968749338" },
    ];
    getFillHistoryRead.mockResolvedValue({ list: exactFills });
    const journalWithoutProviderOrderId = {
      ...journal,
      executionRecords: journal.executionRecords!.map((record) => {
        const { providerOrderId: _omittedProviderOrderId, ...executionResult } = record.executionResult!;
        return { ...record, executionResult };
      }),
    };
    saveJournal(executor, journalWithoutProviderOrderId);
    const noProviderOrderIdResponse = await (TraderAgent.prototype as unknown as { executionQuarantineDiagnostics: (request: Request, url: URL) => Promise<Response> }).executionQuarantineDiagnostics.call(fake, request, new URL(request.url));
    const noProviderOrderIdBody = await noProviderOrderIdResponse.json() as typeof body;
    expect(noProviderOrderIdBody.diagnostics[0]?.providerReadback.matches.order.providerOrderId).toBe(true);
    expect(noProviderOrderIdBody.diagnostics[0]?.providerReadback.matches.aggregateFillQuantity).toBe("3");
    expect(noProviderOrderIdBody.diagnostics[0]?.providerReadback.matches.aggregateFillQuantityMatchesExecution).toBe(true);
    saveJournal(executor, journal);
    getFillHistoryRead.mockResolvedValue({ list: [
      { execId: "invalid-price-fill", orderId: "provider-crcl", clientOid: "client-crcl", symbol: "CRCLUSDT", side: "buy", posSide: "long", tradeSide: "open", execQty: "3", execPrice: "not-a-price", createdTime: "1789968749339" },
    ] });
    const invalidPriceResponse = await (TraderAgent.prototype as unknown as { executionQuarantineDiagnostics: (request: Request, url: URL) => Promise<Response> }).executionQuarantineDiagnostics.call(fake, request, new URL(request.url));
    const invalidPriceBody = await invalidPriceResponse.json() as typeof body;
    expect(invalidPriceBody.diagnostics[0]?.providerReadback.status).toBe("ORDER_AND_FILLS_INCOMPLETE");
    expect(invalidPriceBody.diagnostics[0]?.providerReadback.matches.invalidMatchingProviderFillRows).toBe(1);
    expect(invalidPriceBody.diagnostics[0]?.providerReadback.matches.aggregateFillQuantity).toBeNull();
    expect(invalidPriceBody.diagnostics[0]?.providerReadback.matches.aggregateFillQuantityMatchesExecution).toBe(false);
    expect(JSON.stringify(loadExecutionQuarantines(executor))).toBe(before);
    expect(BitgetClient.prototype.getOrderDetailsRead).toHaveBeenCalledTimes(4);
    expect(BitgetClient.prototype.getFillHistoryRead).toHaveBeenCalledTimes(4);
    expect(placePaperOrder).not.toHaveBeenCalled();
    db.close();
  });

  it("rejects unauthenticated provider-ledger diagnostics before touching storage", async () => {
    const fake = { env: { OWNER_CONTROL_TOKEN: "configured" }, sql: () => { throw new Error("storage must not be read"); } };
    const response = await TraderAgent.prototype.onRequest.call(fake as never, new Request("https://darwin.test/provider-ledger"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "OWNER_AUTH_REQUIRED" });
  });

  it("requires owner auth and PAPER plus PAUSED before lifecycle-performance migration reads", async () => {
    const fake = {
      env: { OWNER_CONTROL_TOKEN: "configured", TRADING_MODE: "PAPER", PAPER_ONLY: "true" },
      state: { paused: false, runtimeStatus: "ONLINE" },
      sql: () => { throw new Error("storage must not be read"); },
    };
    const unauthenticated = await TraderAgent.prototype.onRequest.call(fake as never, new Request("https://darwin.test/provider-performance/rebuild", { method: "POST" }));
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({ error: "OWNER_AUTH_REQUIRED" });

    const notPaused = await TraderAgent.prototype.onRequest.call(fake as never, new Request("https://darwin.test/provider-performance/rebuild", {
      method: "POST",
      headers: { authorization: "Bearer configured" },
    }));
    expect(notPaused.status).toBe(409);
    expect(await notPaused.json()).toEqual({ error: "PROVIDER_PERFORMANCE_REBUILD_REQUIRES_PAPER_PAUSED" });
  });

  it("has no scheduled historical journal migration callback", () => {
    expect(TraderAgent.prototype).not.toHaveProperty("runJournalLookupMigrationBatch");
  });

  it("clamps all client limits to the safe maximum", async () => {
    expect(clampHistoryLimit(25)).toBe(25);
    expect(clampHistoryLimit(999999)).toBe(100);
    expect(clampHistoryLimit(0)).toBe(25);

    const sql = vi.fn(() => [] as never[]);
    const fake = {
      sql,
      env: { TRADING_MODE: "PAPER", AGENT_MODE: "AUTONOMOUS", PAPER_ONLY: "true", EVIDENCE_MAX_AGE_SECONDS: "90", BITGET_CATEGORY: "USDT-FUTURES" },
      ensureActivePolicy: () => policy,
    };
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ ...portfolio, positions: [] });
    for (const method of ["getAgentJournal", "getTradeHistory", "getLearning"] as const) {
      const handler = (TraderAgent.prototype as unknown as Record<string, (url: URL) => Promise<Response> | Response>)[method];
      expect(handler).toBeDefined();
      const response = await handler!.call(fake, new URL(`https://darwin.test/${method}?limit=999999`));
      const body = await response.json() as { limit: number };
      expect(body.limit).toBe(100);
    }
  });

  it("keeps snapshot reads lightweight and reuses one bounded event result", async () => {
    const queries: string[] = [];
    const materializedTotals = {
      source: "PROVIDER_LEDGER",
      closedTrades: 0,
      openTrades: 0,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      closedEpisodeRealizedPnl: "0",
      verifiedRealizedPnl: "0",
      unresolvedClosedLifecycles: 0,
      dailyPnl: {},
    };
    const materialization = {
      version: 1,
      generation: "test-generation",
      phase: "READY",
      cursor: null,
      queueCursor: 0,
      scannedHistories: 0,
      lifecycleRevision: 0,
      identityRevision: 0,
      realizedPnlAccumulator: "0",
      totals: materializedTotals,
    };
    const fake = {
      env: { TRADING_MODE: "PAPER", AGENT_MODE: "AUTONOMOUS", PAPER_ONLY: "true", EVIDENCE_MAX_AGE_SECONDS: "90", BITGET_CATEGORY: "USDT-FUTURES" },
      state: { runtimeStatus: "ONLINE", currentStage: "ONLINE", lastScanAt: null, nextScanAt: null, model: "qwen", temporaryScanIntervalExpiresAt: null, temporaryScanIntervalCompleted: true, paused: true, emergencyStop: false, lastStatus: "IDLE", cycleStartedAt: null },
      ctx: { storage: { transactionSync: <T>(closure: () => T) => closure() } },
      ensureActivePolicy: () => policy,
      activeScanIntervalMinutes: () => 15,
      listSchedules: async () => [],
      reconcileScheduler: (TraderAgent.prototype as unknown as { reconcileScheduler: (intervalMinutes: number, options?: { now?: number }) => Promise<unknown> }).reconcileScheduler,
      getSchedulerDiagnostics: (TraderAgent.prototype as unknown as { getSchedulerDiagnostics: (intervalMinutes: number) => Promise<unknown> }).getSchedulerDiagnostics,
      isProviderSyncSchedulerHealthy: (TraderAgent.prototype as unknown as { isProviderSyncSchedulerHealthy: () => Promise<boolean> }).isProviderSyncSchedulerHealthy,
      sql<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] {
        const query = strings.reduce((query, part, index) => query + part + (index < values.length ? "?" : ""), "");
        queries.push(query);
        if (query.includes("provider_data_revisions AS data")) return PROVIDER_FINANCIAL_CATEGORIES.map((category) => ({ category, lifecycle_revision: 0, financial_revision: 0, identity_revision: 0 })) as T[];
        if (query.includes("SELECT payload FROM risk_state WHERE state_key = ? LIMIT 1")) return [{ payload: JSON.stringify(materialization) }] as T[];
        if (query.includes("FROM provider_performance_change_queue")) return [] as T[];
        return [];
      },
    };
    const snapshot = await TraderAgent.prototype.getDashboardSnapshot.call(fake as never);
    const schemaChecksAfterFirstRead = queries.filter((query) => query.includes("pragma_table_info")).length;
    const repeatedSnapshot = await TraderAgent.prototype.getDashboardSnapshot.call(fake as never);
    expect(schemaChecksAfterFirstRead).toBeGreaterThan(0);
    expect(queries.filter((query) => query.includes("pragma_table_info")).length).toBe(schemaChecksAfterFirstRead);
    expect(snapshot.portfolio).toBeNull();
    expect(repeatedSnapshot.portfolio).toBeNull();
    expect(snapshot.performance.totalTrades).toBeNull();
    expect(snapshot.scheduler).toMatchObject({ nextScanAt: null, nextScanStale: true, configuredIntervalMinutes: 15, matchingScheduleCount: 0, schedulerHealthy: true });
    expect(queries.filter((query) => query.includes("FROM events")).length).toBe(2);
    expect(queries.filter((query) => query.includes("FROM risk_state")).length).toBe(8);
    expect(queries.some((query) => /json_tree\s*\(/i.test(query) && /FROM\s+journals/i.test(query))).toBe(false);
    expect(queries.some((query) => /journal_decision_lookup_migration/i.test(query))).toBe(false);
    const journalReads = queries.filter((query) => /\bFROM\s+journals\b/i.test(query));
    expect(journalReads.every((query) => /\bLIMIT\b/i.test(query) || /\bWHERE\s+cycle_id\s*=\s*\?/i.test(query))).toBe(true);
    expect(queries.filter((query) => query.includes("FROM provider_financial_records")).length).toBe(0);
    expect(queries.some((query) => query.includes("FROM experiences"))).toBe(false);
    expect(queries.some((query) => query.includes("FROM lessons"))).toBe(false);
    expect(queries.some((query) => query.includes("FROM backtests"))).toBe(false);
  });
});
