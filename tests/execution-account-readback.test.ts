import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { loadExecutionQuarantines, saveExecutionQuarantine, saveJournal } from "../src/storage/store.js";
import { BitgetClient } from "../src/bitget/client.js";
import { TraderAgent } from "../src/agent/agent.js";
import { loadConfig } from "../src/config.js";
import { executeCyclePlan } from "../src/trading/execution-planner.js";
import type { AccountSnapshot, Decision, EvidenceBundle, ExecutionResult, Instrument, PositionSnapshot } from "../src/types.js";

afterEach(() => vi.restoreAllMocks());
vi.mock("agents", () => ({ Agent: class {} }));
const NOW = new Date().toISOString();

function memoryExecutor(): { db: DatabaseSync; executor: SqlExecutor } {
  const db = new DatabaseSync(":memory:");
  const executor: SqlExecutor = {
    sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
      const query = strings.reduce((text, part, index) => text + part + (index < values.length ? "?" : ""), "");
      const bound = values.map((value) => typeof value === "boolean" ? Number(value) : value);
      if (/^\s*(SELECT|WITH)\b/i.test(query)) return db.prepare(query).all(...bound) as T[];
      db.prepare(query).run(...bound);
      return [];
    },
  };
  ensureStorage(executor);
  return { db, executor };
}

function account(positions: PositionSnapshot[] = []): AccountSnapshot {
  return {
    balance: "1000", availableBalance: "900", availableMargin: "900", marginUsage: "0",
    positionNotional: "0", totalPositionNotional: "0", positionQuantity: "0", portfolioEquity: "1000",
    positions, realizedPnl: "0", unrealizedPnl: "0", openOrders: 0, openOrderSymbols: [],
    observedAt: NOW,
  };
}

function instrument(symbol: string): Instrument {
  return {
    symbol, category: "USDT-FUTURES", baseCoin: symbol.replace("USDT", ""), quoteCoin: "USDT", marginCoin: "USDT",
    symbolType: "stock", isRwa: "YES", status: "online", minOrderQty: "0.01", maxOrderQty: "100",
    minOrderAmount: "5", pricePrecision: 2, quantityPrecision: 2, quantityStep: "0.01", leverageMin: "1", leverageMax: "5",
  };
}

function bundle(symbol: string): EvidenceBundle {
  return {
    market: { symbol, lastPrice: "100", bidPrice: "99", askPrice: "101", priceChange24h: "0", volume24h: "1000", observedAt: NOW },
    account: account(), instrument: instrument(symbol), evidence: [],
  };
}

function decision(symbol: string, decisionId: string): Decision {
  return {
    decisionId, cycleId: "cycle-readback", action: "OPEN_LONG", positionSide: "LONG", symbol,
    marginAllocationPct: "1", leverage: "1", reductionPct: null, confidence: 0.8,
    thesis: "test planned entry", strategyThesis: "bounded test", supportingFactors: ["evidence"], riskFactors: [],
    evidenceUsed: ["TICKER"], lessonsUsed: [], createdAt: NOW,
  };
}

function fakeAgent(executor: SqlExecutor) {
  return {
    state: { emergencyStop: false },
    sql: executor.sql,
    setState(next: { emergencyStop: boolean }) { this.state = next; },
    recordEvent: vi.fn(),
  };
}

function invokeExecuteDecision(agent: ReturnType<typeof fakeAgent>, client: BitgetClient, next: Decision, bundleValue: EvidenceBundle, config = loadConfig({ TRADING_MODE: "PAPER", AGENT_MODE: "AUTONOMOUS", PAPER_ONLY: "true" })) {
  return (TraderAgent.prototype as unknown as {
    executeDecision: (...args: unknown[]) => Promise<unknown>;
  }).executeDecision.call(agent, client, config, next, bundleValue, next.cycleId, [next.symbol], false, next.createdAt, "NEW_ENTRY", undefined, []);
}

function filledResult(request: Parameters<BitgetClient["placePaperOrder"]>[0]) {
  return {
    provider: "bitget", providerOrderId: `provider-${request.symbol}`, clientOrderId: request.clientOrderId,
    symbol: request.symbol, action: request.action, positionSide: request.positionSide, providerSide: request.providerSide,
    tradeSide: request.tradeSide, marginAllocated: request.marginAllocated, leverage: request.leverage,
    positionNotional: request.positionNotional, requestedQuantity: request.quantity, executedQuantity: request.quantity,
    status: "filled" as const, submittedAt: "2026-10-04T00:00:01.000Z", readBackAt: "2026-10-04T00:00:02.000Z",
  };
}

describe("provider-account-only execution reconciliation", () => {
  it("does not record a risk-blocked reverse as completed position management", async () => {
    const fake = {
      updatePositionContext: vi.fn(),
      updatePerformanceReadModel: vi.fn(),
      recordEvent: vi.fn(),
    };
    const parent = { ...decision("MSTRUSDT", "decision-reverse"), action: "REVERSE" as const, targetPositionSide: "SHORT" as const };
    const close = { ...decision("MSTRUSDT", "decision-reverse:close"), action: "CLOSE" as const };
    const record = {
      decision: close,
      parentDecision: parent,
      parentDecisionId: parent.decisionId,
      parentAction: "REVERSE" as const,
      riskGateResult: { status: "BLOCK" as const, codes: ["OPEN_ORDERS_READ_UNAVAILABLE"], checkedAt: NOW },
    };

    await (TraderAgent.prototype as unknown as { persistDecisionOutcome: (...args: unknown[]) => Promise<unknown> }).persistDecisionOutcome.call(
      fake, {} as never, record, bundle("MSTRUSDT"), [], [], close.cycleId, NOW, { cycleId: close.cycleId } as never, false,
    );

    expect(fake.updatePositionContext).not.toHaveBeenCalled();
  });

  it("blocks financial writes when a successful open-orders response is malformed", async () => {
    const { db, executor } = memoryExecutor();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      const data = path.endsWith("/account-assets")
        ? { usdtEquity: "1000", availableMargin: "900" }
        : path.endsWith("/position-info") ? [] : {};
      return Response.json({ endpoint: "fixture", requestTime: NOW, data });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new BitgetClient(loadConfig({
        TRADING_MODE: "PAPER", AGENT_MODE: "AUTONOMOUS", PAPER_ONLY: "true",
        BITGET_GATEWAY_URL: "https://gateway.test", BITGET_GATEWAY_SERVICE_SECRET: "test-secret",
      }));
      const portfolio = await client.getDashboardPortfolio();
      expect(portfolio.openOrders).toBeNull();
      expect(portfolio.openOrderSymbols).toEqual([]);
      expect(portfolio.openOrdersReadFailure).toMatchObject({ operation: "getOpenOrders" });

      const agent = fakeAgent(executor);
      const placePaperOrder = vi.spyOn(client, "placePaperOrder").mockImplementation(async (request) => filledResult(request));
      const record = await invokeExecuteDecision(agent, client, decision("MSTRUSDT", "decision-malformed-open-orders"), {
        ...bundle("MSTRUSDT"), account: portfolio,
      }) as { riskGateResult: { status: string; codes: string[] } };

      expect(record.riskGateResult).toMatchObject({ status: "BLOCK", codes: ["OPEN_ORDERS_READ_UNAVAILABLE"] });
      expect(placePaperOrder).not.toHaveBeenCalled();
      expect(db.prepare("SELECT decision_id FROM idempotency").all()).toEqual([]);
      expect(agent.recordEvent).toHaveBeenCalledWith("ACTION_SKIPPED", "cycle-readback", expect.objectContaining({ code: "OPEN_ORDERS_READ_UNAVAILABLE" }));
    } finally {
      vi.unstubAllGlobals();
      db.close();
    }
  });

  it("matches a PAPER open from canonical provider positions without ticker or kline reads", async () => {
    const { db, executor } = memoryExecutor();
    try {
      const client = new BitgetClient(loadConfig({ TRADING_MODE: "PAPER", AGENT_MODE: "AUTONOMOUS", PAPER_ONLY: "true" }));
      vi.spyOn(client, "placePaperOrder").mockImplementation(async (request) => filledResult(request));
      const after = account([{
        symbol: "MSTRUSDT", positionSide: "LONG", quantity: "0.1", notional: "10", marginAllocated: "10",
        leverage: "1", entryPrice: "100", markPrice: "100", unrealizedPnl: "0", realizedPnl: "0",
      }]);
      vi.spyOn(client, "getDashboardPortfolio").mockResolvedValue(after);
      const tickerRead = vi.spyOn(client, "getMarketSnapshot").mockRejectedValue(new Error("TICKER_UNAVAILABLE"));
      const klineRead = vi.spyOn(client, "getHistoricalBars").mockRejectedValue(new Error("KLINE_UNAVAILABLE"));
      const record = await invokeExecuteDecision(fakeAgent(executor), client, decision("MSTRUSDT", "decision-mstr"), bundle("MSTRUSDT")) as { reconciliationResult?: { status: string }; accountAfter?: AccountSnapshot };

      expect(record.reconciliationResult?.status).toBe("MATCHED");
      expect(record.accountAfter).toBe(after);
      expect(tickerRead).not.toHaveBeenCalled();
      expect(klineRead).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("blocks actions when the provider open-order read is unavailable and continues with a fresh complete account read", async () => {
    const { db, executor } = memoryExecutor();
    try {
      const client = new BitgetClient(loadConfig({ TRADING_MODE: "PAPER", AGENT_MODE: "AUTONOMOUS", PAPER_ONLY: "true" }));
      const submissions: string[] = [];
      vi.spyOn(client, "placePaperOrder").mockImplementation(async (request) => {
        submissions.push(request.symbol);
        return filledResult(request);
      });
      const completeAfter = account([
        { symbol: "MSTRUSDT", positionSide: "LONG", quantity: "0.1", notional: "10", marginAllocated: "10", leverage: "1", entryPrice: "100", markPrice: "100", unrealizedPnl: "0", realizedPnl: "0" },
        { symbol: "HOODUSDT", positionSide: "LONG", quantity: "0.1", notional: "10", marginAllocated: "10", leverage: "1", entryPrice: "100", markPrice: "100", unrealizedPnl: "0", realizedPnl: "0" },
      ]);
      vi.spyOn(client, "getDashboardPortfolio").mockResolvedValue(completeAfter);
      const agent = fakeAgent(executor);
      const mstrBundle = { ...bundle("MSTRUSDT"), account: { ...account(), openOrders: null, openOrdersReadFailure: { operation: "getOpenOrders", code: "BITGET_READ_FAILED_getOpenOrders_ACCOUNT" } } };
      const hoodBundle = bundle("HOODUSDT");
      const plan = await executeCyclePlan({ positionActions: [], entryActions: [decision("MSTRUSDT", "decision-mstr"), decision("HOODUSDT", "decision-hood")] as never }, {
        refreshEvidence: async (symbol) => symbol === "MSTRUSDT" ? mstrBundle : hoodBundle,
        execute: async (next, evidence) => await invokeExecuteDecision(agent, client, next, evidence) as never,
        persist: async () => undefined,
        refreshPortfolio: async () => completeAfter,
      });

      expect(plan.stoppedAfterAmbiguity).toBe(false);
      expect(submissions).toEqual(["HOODUSDT"]);
      expect(db.prepare("SELECT decision_id FROM idempotency ORDER BY decision_id").all()).toEqual([{ decision_id: "decision-hood" }]);
      expect(agent.recordEvent).toHaveBeenCalledWith("ACTION_SKIPPED", "cycle-readback", expect.objectContaining({ symbol: "MSTRUSDT", code: "OPEN_ORDERS_READ_UNAVAILABLE", providerOperation: "getOpenOrders" }));
    } finally {
      db.close();
    }
  });

  it("does not quarantine an execution proven rejected before provider acceptance", async () => {
    const { db, executor } = memoryExecutor();
    try {
      const client = new BitgetClient(loadConfig({ TRADING_MODE: "PAPER", AGENT_MODE: "AUTONOMOUS", PAPER_ONLY: "true" }));
      vi.spyOn(client, "placePaperOrder").mockImplementation(async (request) => {
        const rejected: ExecutionResult = {
          ...filledResult(request),
          executedQuantity: "0",
          status: "rejected",
          providerFailureClass: "PROVIDER_REJECTED",
          providerReadbackFailureClass: "PROVIDER_NOT_FOUND",
        };
        delete rejected.providerOrderId;
        return rejected;
      });
      vi.spyOn(client, "getDashboardPortfolio").mockResolvedValue(account());
      const record = await invokeExecuteDecision(fakeAgent(executor), client, decision("MSTRUSDT", "decision-rejected"), bundle("MSTRUSDT")) as { reconciliationResult?: { status: string } };

      expect(record.reconciliationResult?.status).toBe("MISMATCH");
      expect(loadExecutionQuarantines(executor)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not reseed durable quarantine from historical definitive rejection", () => {
    const { db, executor } = memoryExecutor();
    try {
      const next = decision("MSTRUSDT", "decision-historical-rejected");
      const rejected: ExecutionResult = {
        ...filledResult({
          cycleId: next.cycleId, decisionId: next.decisionId, symbol: next.symbol, action: "OPEN_LONG", positionSide: "LONG", providerSide: "buy", tradeSide: "open", marginAllocated: "10", leverage: "1", positionNotional: "10", reductionPct: null, quantity: "0.1", clientOrderId: "rejected-order",
        }),
        clientOrderId: "rejected-order",
        executedQuantity: "0",
        status: "rejected",
        providerFailureClass: "PROVIDER_REJECTED",
        providerReadbackFailureClass: "PROVIDER_NOT_FOUND",
      };
      delete rejected.providerOrderId;
      const uncertainDecision = decision("TSLAUSDT", "decision-historical-unknown");
      const unknown: ExecutionResult = { ...rejected, symbol: uncertainDecision.symbol, clientOrderId: "unknown-order", status: "unknown" };
      delete unknown.providerFailureClass;
      delete unknown.providerReadbackFailureClass;
      const rejectedRequest = { cycleId: next.cycleId, decisionId: next.decisionId, symbol: next.symbol, action: "OPEN_LONG" as const, positionSide: "LONG" as const, providerSide: "buy" as const, tradeSide: "open" as const, marginAllocated: "10", leverage: "1", positionNotional: "10", reductionPct: null, quantity: "0.1", clientOrderId: "rejected-order" };
      const unknownRequest = { ...rejectedRequest, decisionId: uncertainDecision.decisionId, symbol: uncertainDecision.symbol, clientOrderId: "unknown-order" };
      saveExecutionQuarantine(executor, {
        symbol: next.symbol,
        decisionId: next.decisionId,
        cycleId: next.cycleId,
        clientOrderId: "rejected-order",
        reason: "PROVIDER_REJECTED",
        createdAt: rejected.submittedAt,
      });
      saveJournal(executor, {
        cycleId: next.cycleId, agentVersion: "test", model: "test", mode: "AUTONOMOUS", startedAt: NOW,
        retrievedLessons: [], createdLessons: [],
        executionRecords: [
          {
            decision: next,
            riskGateResult: { status: "PASS", codes: [], checkedAt: NOW },
            executionRequest: rejectedRequest,
            executionResult: rejected,
            reconciliationResult: { status: "MISMATCH", codes: ["PROVIDER_REJECTED"], execution: rejected },
          },
          {
            decision: uncertainDecision,
            riskGateResult: { status: "PASS", codes: [], checkedAt: NOW },
            executionRequest: unknownRequest,
            executionResult: unknown,
            reconciliationResult: { status: "UNKNOWN", codes: ["EXECUTION_UNKNOWN"], execution: unknown },
          },
        ],
      });

      const agent = fakeAgent(executor);
      (TraderAgent.prototype as unknown as { seedExecutionQuarantinesFromRecentJournals: () => void }).seedExecutionQuarantinesFromRecentJournals.call(agent);

      expect(loadExecutionQuarantines(executor)).toMatchObject([{ symbol: "TSLAUSDT", decisionId: "decision-historical-unknown" }]);
    } finally {
      db.close();
    }
  });

  it.each(["cycleId", "decisionId"] as const)("preserves a rejection quarantine when the stored request %s differs from its journal identity", (mismatchField) => {
    const { db, executor } = memoryExecutor();
    try {
      const currentDecision = decision("MSTRUSDT", "decision-journal-identity");
      const request = {
        cycleId: mismatchField === "cycleId" ? "different-cycle" : currentDecision.cycleId,
        decisionId: mismatchField === "decisionId" ? "different-decision" : currentDecision.decisionId,
        symbol: currentDecision.symbol, action: "OPEN_LONG" as const, positionSide: "LONG" as const,
        providerSide: "buy" as const, tradeSide: "open" as const, marginAllocated: "10", leverage: "1",
        positionNotional: "10", reductionPct: null, quantity: "0.1", clientOrderId: "rejected-identity-order",
      };
      const rejected: ExecutionResult = {
        provider: "bitget", clientOrderId: request.clientOrderId, symbol: currentDecision.symbol,
        action: request.action, positionSide: request.positionSide, providerSide: request.providerSide,
        tradeSide: request.tradeSide, marginAllocated: request.marginAllocated, leverage: request.leverage,
        positionNotional: request.positionNotional, requestedQuantity: request.quantity, executedQuantity: "0",
        status: "rejected", submittedAt: NOW, readBackAt: NOW,
        providerFailureClass: "PROVIDER_REJECTED", providerReadbackFailureClass: "PROVIDER_NOT_FOUND",
      };
      saveExecutionQuarantine(executor, {
        symbol: currentDecision.symbol, decisionId: currentDecision.decisionId, cycleId: currentDecision.cycleId,
        clientOrderId: request.clientOrderId, reason: "PROVIDER_REJECTED", createdAt: NOW,
      });
      saveJournal(executor, {
        cycleId: currentDecision.cycleId, agentVersion: "test", model: "test", mode: "AUTONOMOUS", startedAt: NOW,
        retrievedLessons: [], createdLessons: [],
        executionRecords: [{
          decision: currentDecision,
          riskGateResult: { status: "PASS", codes: [], checkedAt: NOW },
          executionRequest: request,
          executionResult: rejected,
          reconciliationResult: { status: "MISMATCH", codes: ["PROVIDER_REJECTED"], execution: rejected },
        }],
      });

      const agent = fakeAgent(executor);
      (TraderAgent.prototype as unknown as { seedExecutionQuarantinesFromRecentJournals: () => void }).seedExecutionQuarantinesFromRecentJournals.call(agent);

      expect(loadExecutionQuarantines(executor)).toMatchObject([{ symbol: currentDecision.symbol, decisionId: currentDecision.decisionId, cycleId: currentDecision.cycleId, clientOrderId: request.clientOrderId }]);
    } finally {
      db.close();
    }
  });

  it("backfills unresolved executions beyond the recent-journal window", () => {
    const { db, executor } = memoryExecutor();
    try {
      const oldDecision = decision("MSTRUSDT", "decision-old-unresolved");
      const request = {
        cycleId: oldDecision.cycleId, decisionId: oldDecision.decisionId, symbol: oldDecision.symbol,
        action: "OPEN_LONG" as const, positionSide: "LONG" as const, providerSide: "buy" as const,
        tradeSide: "open" as const, marginAllocated: "10", leverage: "1", positionNotional: "10",
        reductionPct: null, quantity: "0.1", clientOrderId: "old-unresolved-order",
      };
      const unresolved: ExecutionResult = { ...filledResult(request), status: "unknown" };
      saveJournal(executor, {
        cycleId: oldDecision.cycleId, agentVersion: "test", model: "test", mode: "AUTONOMOUS",
        startedAt: "2026-01-01T00:00:00.000Z", retrievedLessons: [], createdLessons: [],
        executionRecords: [{
          decision: oldDecision,
          riskGateResult: { status: "PASS", codes: [], checkedAt: NOW },
          executionRequest: request,
          executionResult: unresolved,
          reconciliationResult: { status: "UNKNOWN", codes: ["EXECUTION_UNKNOWN"], execution: unresolved },
        }],
      });
      for (let index = 0; index < 51; index += 1) {
        const sequence = String(index).padStart(2, "0");
        saveJournal(executor, {
          cycleId: `cycle-newer-${sequence}`, agentVersion: "test", model: "test", mode: "AUTONOMOUS",
          startedAt: `2026-01-02T00:${sequence}:00.000Z`, retrievedLessons: [], createdLessons: [],
        });
      }

      const agent = fakeAgent(executor);
      (TraderAgent.prototype as unknown as { seedExecutionQuarantinesFromRecentJournals: () => void }).seedExecutionQuarantinesFromRecentJournals.call(agent);

      expect(loadExecutionQuarantines(executor)).toMatchObject([{ symbol: "MSTRUSDT", decisionId: "decision-old-unresolved", clientOrderId: "old-unresolved-order" }]);
    } finally {
      db.close();
    }
  });

  it("marks canonical post-write account failure UNKNOWN, quarantines the symbol, and stops later writes", async () => {
    const { db, executor } = memoryExecutor();
    try {
      const client = new BitgetClient(loadConfig({ TRADING_MODE: "PAPER", AGENT_MODE: "AUTONOMOUS", PAPER_ONLY: "true" }));
      const submissions: string[] = [];
      vi.spyOn(client, "placePaperOrder").mockImplementation(async (request) => { submissions.push(request.symbol); return filledResult(request); });
      vi.spyOn(client, "getDashboardPortfolio").mockRejectedValue(new Error("ACCOUNT_READBACK_UNAVAILABLE"));
      const mstr = decision("MSTRUSDT", "decision-mstr");
      const other = decision("TSLAUSDT", "decision-tsla");
      const records: Array<{ decision: Decision; reconciliationResult?: { status: string; codes: string[] } }> = [];
      const agent = fakeAgent(executor);
      const result = await executeCyclePlan({ positionActions: [], entryActions: [mstr, other] as never }, {
        refreshEvidence: async (symbol) => bundle(symbol),
        execute: async (next, evidence) => {
          const execution = await invokeExecuteDecision(agent, client, next, evidence) as { reconciliationResult?: { status: string; codes: string[] } };
          const record = { decision: next, ...execution };
          records.push(record);
          return record as never;
        },
        persist: async () => undefined,
        refreshPortfolio: async () => account(),
      });

      expect(result.stoppedAfterAmbiguity).toBe(true);
      expect(submissions).toEqual(["MSTRUSDT"]);
      expect(records).toHaveLength(1);
      expect(records[0]?.reconciliationResult?.status).toBe("UNKNOWN");
      expect(records[0]?.reconciliationResult?.codes).toContain("POSITION_READBACK_UNAVAILABLE");
      expect(loadExecutionQuarantines(executor)).toMatchObject([{ symbol: "MSTRUSDT", decisionId: "decision-mstr", cycleId: "cycle-readback" }]);
    } finally {
      db.close();
    }
  });
});
