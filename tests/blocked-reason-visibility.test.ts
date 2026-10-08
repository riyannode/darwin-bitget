import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ensureStorage, type SqlExecutor } from "../src/storage/schema.js";
import { saveExperience, saveJournal } from "../src/storage/store.js";
import { blockedRiskGateResult } from "../src/storage/journal-normalizer.js";
import { TraderAgent } from "../src/agent/agent.js";
import { BitgetClient } from "../src/bitget/client.js";
import type { DecisionExecutionRecord, EntryDecision, PositionManagementDecision, RiskGateResult, TradeExperience, TradingJournal } from "../src/types.js";

vi.mock("agents", () => ({ Agent: class {} }));

const AT = "2026-10-08T03:00:00.000Z";

function memoryExecutor(db = new DatabaseSync(":memory:")) {
  const executor: SqlExecutor = {
    sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
      const query = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
      const params = values.map((value) => (typeof value === "boolean" ? Number(value) : value)) as (string | number | null)[];
      const normalized = query.trimStart().toUpperCase();
      if (normalized.startsWith("SELECT") || normalized.startsWith("WITH")) return db.prepare(query).all(...params) as T[];
      db.prepare(query).run(...params);
      return [];
    },
  };
  ensureStorage(executor);
  return { db, executor };
}

function fakeAgent(executor: SqlExecutor, db: DatabaseSync) {
  return {
    sql: executor.sql,
    env: { TRADING_MODE: "PAPER", PAPER_ONLY: "true", AGENT_MODE: "AUTONOMOUS", BITGET_CATEGORY: "USDT-FUTURES", OWNER_CONTROL_TOKEN: "owner-control-test-token" },
    state: { paused: false, runtimeStatus: "ONLINE" },
    ctx: { storage: { transactionSync: <T>(closure: () => T) => { db.exec("BEGIN IMMEDIATE"); try { const value = closure(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; } } } },
    ensureActivePolicy: () => ({ paperOnly: true, maxSinglePositionMarginPct: "30", maxLeverage: "5", maxDailyDrawdownPct: "10", drawdownCooldownMinutes: 60, scanIntervalMinutes: 5, emergencyStop: false }),
    getTradeHistory: (TraderAgent.prototype as unknown as { getTradeHistory: (url: URL) => Promise<Response> }).getTradeHistory,
    onRequest: TraderAgent.prototype.onRequest,
  };
}

function decision(decisionId: string, cycleId: string): EntryDecision {
  return {
    decisionId, cycleId, action: "OPEN_LONG", positionSide: "LONG", symbol: "SAMSUNGUSDT",
    marginAllocationPct: "40", leverage: "3", reductionPct: null, confidence: 0.42,
    thesis: "blocked proposal", strategyThesis: "bounded strategy",
    supportingFactors: ["volume"], riskFactors: ["drawdown"], evidenceUsed: ["ticker"], lessonsUsed: [],
    createdAt: AT,
  };
}

function managementDecision(decisionId: string, cycleId: string, action: "CLOSE" | "REDUCE" = "CLOSE"): PositionManagementDecision {
  return {
    ...decision(decisionId, cycleId),
    action,
    reductionPct: action === "REDUCE" ? "50" : null,
  };
}

function blockedExperience(decisionId: string, overrides: Partial<TradeExperience> = {}): TradeExperience {
  return {
    experienceId: "exp-blocked", symbol: "SAMSUNGUSDT", positionSide: "LONG", action: "OPEN_LONG",
    entryDecisionId: decisionId, entryPrice: "198.02", entryTime: AT, exitDecisionId: "", exitPrice: "0", exitTime: "",
    selectedLeverage: "3", marginAllocationPct: "40", marginAllocated: "400", positionNotional: "1200",
    realizedPnl: "0", realizedPnlPct: "0", maximumFavorableExcursion: "0", maximumAdverseExcursion: "0",
    drawdownContribution: "0", liquidationDistance: "0", entryThesis: "blocked proposal", exitThesis: "",
    evidenceAtEntry: ["ticker"], evidenceAtExit: [], lessonsUsed: [], marketContext: "TREND_UP",
    outcomeStatus: "BLOCKED", lastAction: "OPEN_LONG", ...overrides,
  };
}

function blockedJournal(decisionId: string, codes: string[], overrides: Partial<TradingJournal> = {}): TradingJournal {
  const current = decision(decisionId, "cycle-blocked");
  const record: DecisionExecutionRecord = { decision: current, riskGateResult: { status: "BLOCK", codes, checkedAt: AT } };
  return {
    cycleId: "cycle-blocked", agentVersion: "test", model: "test", mode: "AUTONOMOUS",
    startedAt: AT, completedAt: AT, retrievedLessons: [], createdLessons: [],
    cyclePlan: { positionActions: [], entryActions: [current] },
    executionRecords: [record],
    experienceIds: ["exp-blocked"], experienceId: "exp-blocked",
    ...overrides,
  };
}

function journalWithGate(decisionId: string, result: RiskGateResult, cycleId = "cycle-blocked"): TradingJournal {
  const current = decision(decisionId, cycleId);
  return {
    cycleId, agentVersion: "test", model: "test", mode: "AUTONOMOUS",
    startedAt: AT, completedAt: AT, retrievedLessons: [], createdLessons: [],
    cyclePlan: { positionActions: [], entryActions: [current] },
    executionRecords: [{ decision: current, riskGateResult: result }],
    experienceIds: ["exp-blocked"], experienceId: "exp-blocked",
  };
}

async function tradeHistory(executor: SqlExecutor, db: DatabaseSync): Promise<Array<Record<string, unknown>>> {
  const agent = fakeAgent(executor, db) as never;
  const response = await (agent as { onRequest: (request: Request) => Promise<Response> }).onRequest.call(agent, new Request("https://example.test/trade-history?limit=25"));
  expect(response.status).toBe(200);
  return (await response.json() as { trades: Array<Record<string, unknown>> }).trades;
}

describe("blocked proposal risk gate reason", () => {
  it.each(["CLOSE", "REDUCE"] as const)("retrieves a BLOCKED %s decision by exitDecisionId and returns its persisted evaluation", async (action) => {
    const { db, executor } = memoryExecutor();
    const decisionId = `dec-blocked-${action.toLowerCase()}`;
    const codes = ["DAILY_DRAWDOWN", "STALE_EVIDENCE", "MIN_ORDER_AMOUNT"];
    const management = managementDecision(decisionId, "cycle-management", action);
    const journal: TradingJournal = {
      cycleId: "cycle-management", agentVersion: "test", model: "test", mode: "AUTONOMOUS",
      startedAt: AT, completedAt: AT, retrievedLessons: [], createdLessons: [],
      cyclePlan: { positionActions: [management], entryActions: [] },
      executionRecords: [{ decision: management, riskGateResult: { status: "BLOCK", codes, checkedAt: AT } }],
    };
    saveJournal(executor, journal);
    saveExperience(executor, blockedExperience("", {
      experienceId: `exp-blocked-${action.toLowerCase()}`, action, lastAction: action,
      entryDecisionId: "", exitDecisionId: decisionId,
    }), AT);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: AT } as never);

    const [trade] = await tradeHistory(executor, db);
    expect(trade).toMatchObject({ status: "BLOCKED", action, blockedReasonCodes: codes, riskGateCheckedAt: AT });
    db.close();
  });

  it("surfaces every persisted gate code on the BLOCKED trade row", async () => {
    const { db, executor } = memoryExecutor();
    const codes = ["DAILY_DRAWDOWN", "STALE_EVIDENCE", "MIN_ORDER_AMOUNT"];
    saveJournal(executor, blockedJournal("dec-1", codes));
    saveExperience(executor, blockedExperience("dec-1"), AT);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: AT } as never);

    const [trade] = await tradeHistory(executor, db);
    expect(trade).toMatchObject({ status: "BLOCKED", blockedReasonCodes: codes, riskGateCheckedAt: AT });
    db.close();
  });

  it("keeps a single persisted gate code intact", async () => {
    const { db, executor } = memoryExecutor();
    saveJournal(executor, blockedJournal("dec-2", ["INSUFFICIENT_MARGIN"]));
    saveExperience(executor, blockedExperience("dec-2"), AT);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: AT } as never);

    const [trade] = await tradeHistory(executor, db);
    expect(trade).toMatchObject({ status: "BLOCKED", blockedReasonCodes: ["INSUFFICIENT_MARGIN"] });
    db.close();
  });

  it("omits the reason entirely when no persisted gate is attributable", async () => {
    const { db, executor } = memoryExecutor();
    saveExperience(executor, blockedExperience("dec-missing"), AT);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: AT } as never);

    const [trade] = await tradeHistory(executor, db);
    expect(trade).toMatchObject({ status: "BLOCKED" });
    expect(trade).not.toHaveProperty("blockedReasonCodes");
    expect(trade).not.toHaveProperty("riskGateCheckedAt");
    db.close();
  });

  it("does not leak a gate result from a PASS evaluation onto a BLOCKED row", async () => {
    const { db, executor } = memoryExecutor();
    const journal = blockedJournal("dec-pass", ["INSUFFICIENT_MARGIN"]);
    const passing: RiskGateResult = { status: "PASS", codes: [], checkedAt: AT };
    journal.executionRecords = [{ decision: journal.cyclePlan!.entryActions[0]!, riskGateResult: passing }];
    saveJournal(executor, journal);
    saveExperience(executor, blockedExperience("dec-pass"), AT);
    vi.spyOn(BitgetClient.prototype, "getDashboardPortfolio").mockResolvedValue({ positions: [], portfolioEquity: "1000", observedAt: AT } as never);

    const [trade] = await tradeHistory(executor, db);
    expect(trade).toMatchObject({ status: "BLOCKED" });
    expect(trade).not.toHaveProperty("blockedReasonCodes");
    db.close();
  });

  it("never attributes a reason to a non-BLOCKED row", () => {
    const journal = blockedJournal("dec-open", ["DAILY_DRAWDOWN"]);
    const open = blockedExperience("dec-open", { outcomeStatus: "OPEN" });
    expect(blockedRiskGateResult(open, [journal])).toBeUndefined();
  });

  it("refuses attribution when two journals disagree about the same decision", () => {
    const journalA = journalWithGate("dec-conflict", { status: "BLOCK", codes: ["DAILY_DRAWDOWN"], checkedAt: AT });
    const journalB = journalWithGate("dec-conflict", { status: "BLOCK", codes: ["MIN_ORDER_AMOUNT"], checkedAt: AT });
    expect(blockedRiskGateResult(blockedExperience("dec-conflict"), [journalA, journalB])).toBeUndefined();
  });

  it("rejects PASS and BLOCK evaluations for the same decision identity", () => {
    const blocked = { status: "BLOCK", codes: ["DAILY_DRAWDOWN"], checkedAt: AT } satisfies RiskGateResult;
    const passed = { status: "PASS", codes: [], checkedAt: AT } satisfies RiskGateResult;
    expect(blockedRiskGateResult(blockedExperience("dec-status-conflict"), [
      journalWithGate("dec-status-conflict", blocked), journalWithGate("dec-status-conflict", passed),
    ])).toBeUndefined();
  });

  it("rejects a legacy journal-level PASS conflicting with its execution-record BLOCK", () => {
    const journal = journalWithGate("dec-internal-conflict", { status: "BLOCK", codes: ["DAILY_DRAWDOWN"], checkedAt: AT });
    journal.decision = journal.cyclePlan!.entryActions[0]!;
    journal.riskGateResult = { status: "PASS", codes: [], checkedAt: AT };
    expect(blockedRiskGateResult(blockedExperience("dec-internal-conflict"), [journal])).toBeUndefined();
  });

  it("rejects evaluations with conflicting persisted decision identity", () => {
    const result = { status: "BLOCK", codes: ["DAILY_DRAWDOWN"], checkedAt: AT } satisfies RiskGateResult;
    const experience = blockedExperience("dec-identity-conflict");
    expect(blockedRiskGateResult(experience, [
      journalWithGate("dec-identity-conflict", result, "cycle-identity-a"),
      journalWithGate("dec-identity-conflict", result, "cycle-identity-b"),
    ])).toBeUndefined();
  });

  it("rejects a persisted BLOCK whose decision cycle conflicts with its journal cycle", () => {
    const journal = journalWithGate("dec-cycle-mismatch", { status: "BLOCK", codes: ["DAILY_DRAWDOWN"], checkedAt: AT });
    journal.cycleId = "cycle-container-mismatch";
    expect(blockedRiskGateResult(blockedExperience("dec-cycle-mismatch"), [journal])).toBeUndefined();
  });

  it("rejects BLOCK evaluations with conflicting evaluation timestamps", () => {
    const first = { status: "BLOCK", codes: ["DAILY_DRAWDOWN"], checkedAt: AT } satisfies RiskGateResult;
    const second = { status: "BLOCK", codes: ["DAILY_DRAWDOWN"], checkedAt: "2026-10-08T03:01:00.000Z" } satisfies RiskGateResult;
    expect(blockedRiskGateResult(blockedExperience("dec-time-conflict"), [
      journalWithGate("dec-time-conflict", first), journalWithGate("dec-time-conflict", second),
    ])).toBeUndefined();
  });

  it("preserves a unique authoritative BLOCK evaluation", () => {
    const result = { status: "BLOCK", codes: ["DAILY_DRAWDOWN", "STALE_EVIDENCE"], checkedAt: AT } satisfies RiskGateResult;
    expect(blockedRiskGateResult(blockedExperience("dec-unique"), [journalWithGate("dec-unique", result)])).toEqual(result);
  });

  it("returns no attribution without a journal or decision identity", () => {
    expect(blockedRiskGateResult(blockedExperience("dec-absent"), [])).toBeUndefined();
    expect(blockedRiskGateResult(blockedExperience(""), [journalWithGate("dec-unrelated", { status: "BLOCK", codes: ["DAILY_DRAWDOWN"], checkedAt: AT })])).toBeUndefined();
  });

  it("ignores a gate that reported BLOCK with no codes", () => {
    const journal = blockedJournal("dec-empty", []);
    expect(blockedRiskGateResult(blockedExperience("dec-empty"), [journal])).toBeUndefined();
  });
});