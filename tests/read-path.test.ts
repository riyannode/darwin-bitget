import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("agents", () => ({ Agent: class {}, routeAgentRequest: vi.fn() }));
import server from "../src/server.js";
import { BitgetClient } from "../src/bitget/client.js";
import { TraderAgent } from "../src/agent/agent.js";
import { clampHistoryLimit } from "../src/storage/store.js";
import type { AccountSnapshot, Env, OwnerPolicy } from "../src/types.js";

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
    const fake = {
      env: { TRADING_MODE: "PAPER", AGENT_MODE: "AUTONOMOUS", PAPER_ONLY: "true", EVIDENCE_MAX_AGE_SECONDS: "90", BITGET_CATEGORY: "USDT-FUTURES" },
      state: { runtimeStatus: "ONLINE", currentStage: "ONLINE", lastScanAt: null, nextScanAt: null, model: "qwen", temporaryScanIntervalExpiresAt: null, temporaryScanIntervalCompleted: true, paused: true, emergencyStop: false, lastStatus: "IDLE", cycleStartedAt: null },
      ensureActivePolicy: () => policy,
      activeScanIntervalMinutes: () => 15,
      listSchedules: async () => [],
      reconcileScheduler: (TraderAgent.prototype as unknown as { reconcileScheduler: (intervalMinutes: number, options?: { now?: number }) => Promise<unknown> }).reconcileScheduler,
      getSchedulerDiagnostics: (TraderAgent.prototype as unknown as { getSchedulerDiagnostics: (intervalMinutes: number) => Promise<unknown> }).getSchedulerDiagnostics,
      isProviderSyncSchedulerHealthy: (TraderAgent.prototype as unknown as { isProviderSyncSchedulerHealthy: () => Promise<boolean> }).isProviderSyncSchedulerHealthy,
      sql(strings: TemplateStringsArray, ...values: unknown[]) {
        queries.push(strings.reduce((query, part, index) => query + part + (index < values.length ? "?" : ""), ""));
        return [];
      },
    };
    const snapshot = await TraderAgent.prototype.getDashboardSnapshot.call(fake as never);
    expect(snapshot.portfolio).toBeNull();
    expect(snapshot.performance.totalTrades).toBeNull();
    expect(snapshot.scheduler).toMatchObject({ nextScanAt: null, nextScanStale: true, configuredIntervalMinutes: 15, matchingScheduleCount: 0, schedulerHealthy: true });
    expect(queries.filter((query) => query.includes("FROM events")).length).toBe(1);
    expect(queries.filter((query) => query.includes("FROM risk_state")).length).toBe(6);
    expect(queries.filter((query) => query.includes("FROM provider_financial_records")).length).toBe(0);
    expect(queries.some((query) => query.includes("FROM experiences"))).toBe(false);
    expect(queries.some((query) => query.includes("FROM lessons"))).toBe(false);
    expect(queries.some((query) => query.includes("FROM backtests"))).toBe(false);
  });
});
